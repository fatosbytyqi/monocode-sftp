//! Transfers: upload / download of files and folders, and directory sync in
//! either or both directions, honoring `ignore`, `syncOption`,
//! `remoteTimeOffsetInHours` and `concurrency`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::config::{self, Resolved};
use super::prompt::Ctx;
use super::remote::{mtime_secs, set_local_mtime, Entry, Kind, Remote};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    LocalToRemote,
    RemoteToLocal,
    Both,
}

#[derive(Debug)]
enum Task {
    Upload {
        local: PathBuf,
        remote: String,
        mtime: i64,
    },
    Download {
        remote: String,
        local: PathBuf,
        mtime: i64,
    },
}

#[derive(Debug)]
enum Removal {
    Remote { path: String, dir: bool },
    Local { path: PathBuf, dir: bool },
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub skipped: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    running: usize,
    label: String,
    done: usize,
    total: usize,
}

/// Paths this app wrote recently, so the watcher does not echo them back.
#[derive(Default)]
pub struct Recent(StdMutex<HashMap<PathBuf, Instant>>);

impl Recent {
    pub fn mark(&self, path: &Path) {
        let mut map = self.0.lock().unwrap();
        map.retain(|_, t| t.elapsed() < Duration::from_secs(10));
        map.insert(path.to_path_buf(), Instant::now());
    }

    pub fn is_recent(&self, path: &Path) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(path)
            .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
    }
}

pub struct Run {
    pub ctx: Arc<Ctx>,
    pub remote: Arc<Remote>,
    pub cfg: Arc<Resolved>,
    pub cancel: CancellationToken,
    pub recent: Arc<Recent>,
    pub running: Arc<AtomicUsize>,
    /// Skip `ignore` rules (the *Force* commands).
    pub force: bool,
    pub label: String,
}

impl Run {
    fn status(&self, done: usize, total: usize) {
        self.ctx.emit(
            "sftp-status",
            Status {
                running: self.running.load(Ordering::SeqCst),
                label: self.label.clone(),
                done,
                total,
            },
        );
    }

    fn ignored(&self, local: &Path, is_dir: bool) -> bool {
        !self.force && self.cfg.is_ignored(local, is_dir)
    }

    fn remote_to_local_time(&self, mtime: i64) -> i64 {
        if mtime == 0 {
            0
        } else {
            mtime - self.cfg.remote_time_offset_secs
        }
    }

    fn remote_of(&self, local: &Path) -> Result<String, String> {
        self.cfg.to_remote(local).ok_or_else(|| {
            format!(
                "{} is outside the SFTP context {}",
                local.display(),
                self.cfg.context.display()
            )
        })
    }

    fn local_of(&self, remote: &str) -> Result<PathBuf, String> {
        self.cfg
            .to_local(remote)
            .ok_or_else(|| format!("{remote} is outside remotePath {}", self.cfg.remote_path))
    }

    // ------------------------------------------------------------ entry points

    pub async fn upload(&self, locals: &[PathBuf]) -> Summary {
        let mut tasks = Vec::new();
        let mut summary = Summary::default();
        for local in locals {
            match self.collect_upload(local, &mut tasks, &mut summary).await {
                Ok(()) => {}
                Err(e) => fail(&mut summary, e),
            }
        }
        self.execute(tasks, vec![], summary).await
    }

    pub async fn download(&self, remotes: &[String]) -> Summary {
        let mut tasks = Vec::new();
        let mut summary = Summary::default();
        for remote in remotes {
            if let Err(e) = self
                .collect_download(remote, &mut tasks, &mut summary)
                .await
            {
                fail(&mut summary, e);
            }
        }
        self.execute(tasks, vec![], summary).await
    }

    pub async fn sync(&self, local: &Path, direction: Direction) -> Summary {
        let mut tasks = Vec::new();
        let mut removals = Vec::new();
        let mut summary = Summary::default();
        match self.remote_of(local) {
            Ok(remote) => {
                if let Err(e) = self
                    .sync_dir(
                        local.to_path_buf(),
                        remote,
                        direction,
                        &mut tasks,
                        &mut removals,
                        &mut summary,
                    )
                    .await
                {
                    fail(&mut summary, e);
                }
            }
            Err(e) => fail(&mut summary, e),
        }
        self.execute(tasks, removals, summary).await
    }

    pub async fn delete_remote(&self, remotes: &[String]) -> Summary {
        let mut summary = Summary::default();
        let mut removals = Vec::new();
        for remote in remotes {
            match self.remote.stat(remote).await {
                Ok(Some(e)) => removals.push(Removal::Remote {
                    path: remote.clone(),
                    dir: e.kind == Kind::Dir,
                }),
                Ok(None) => summary.skipped += 1,
                Err(e) => fail(&mut summary, e),
            }
        }
        self.execute(vec![], removals, summary).await
    }

    // ------------------------------------------------------------ planning

    async fn collect_upload(
        &self,
        local: &Path,
        tasks: &mut Vec<Task>,
        summary: &mut Summary,
    ) -> Result<(), String> {
        let meta = tokio::fs::metadata(local)
            .await
            .map_err(|e| format!("{}: {e}", local.display()))?;
        if self.ignored(local, meta.is_dir()) {
            self.ctx.info(format!("Ignored {}", local.display()));
            summary.skipped += 1;
            return Ok(());
        }
        if meta.is_file() {
            tasks.push(Task::Upload {
                local: local.to_path_buf(),
                remote: self.remote_of(local)?,
                mtime: mtime_secs(&meta),
            });
            return Ok(());
        }
        let files = self.walk_local(local)?;
        // Create the folder even when it is genuinely empty, but not when
        // everything inside it is ignored (e.g. a `.vscode` holding sftp.json).
        let empty = std::fs::read_dir(local)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if files.is_empty() && !empty {
            summary.skipped += 1;
            return Ok(());
        }
        for (path, meta) in files {
            tasks.push(Task::Upload {
                remote: self.remote_of(&path)?,
                local: path,
                mtime: mtime_secs(&meta),
            });
        }
        if empty {
            self.remote.mkdir_p(&self.remote_of(local)?).await?;
        }
        Ok(())
    }

    async fn collect_download(
        &self,
        remote: &str,
        tasks: &mut Vec<Task>,
        summary: &mut Summary,
    ) -> Result<(), String> {
        let Some(entry) = self.remote.stat(remote).await? else {
            return Err(format!("{remote} does not exist on the server"));
        };
        let local = self.local_of(remote)?;
        if self.ignored(&local, entry.kind == Kind::Dir) {
            self.ctx.info(format!("Ignored {remote}"));
            summary.skipped += 1;
            return Ok(());
        }
        if entry.kind != Kind::Dir {
            tasks.push(Task::Download {
                remote: remote.to_string(),
                local,
                mtime: self.remote_to_local_time(entry.mtime),
            });
            return Ok(());
        }
        let _ = std::fs::create_dir_all(&local);
        for entry in self.walk_remote(remote).await? {
            tasks.push(Task::Download {
                local: self.local_of(&entry.path)?,
                mtime: self.remote_to_local_time(entry.mtime),
                remote: entry.path,
            });
        }
        Ok(())
    }

    fn walk_local(&self, root: &Path) -> Result<Vec<(PathBuf, std::fs::Metadata)>, String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            for entry in rd.flatten() {
                let path = entry.path();
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                if self.ignored(&path, meta.is_dir()) {
                    continue;
                }
                if meta.is_dir() {
                    stack.push(path);
                } else if meta.is_file() {
                    out.push((path, meta));
                }
            }
        }
        Ok(out)
    }

    async fn walk_remote(&self, root: &str) -> Result<Vec<Entry>, String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_string()];
        while let Some(dir) = stack.pop() {
            if self.cancel.is_cancelled() {
                break;
            }
            for entry in self.remote.list(&dir).await? {
                let is_dir = entry.kind == Kind::Dir;
                if !self.force && self.cfg.is_ignored_remote(&entry.path, is_dir) {
                    continue;
                }
                if is_dir {
                    stack.push(entry.path);
                } else if entry.kind == Kind::File {
                    out.push(entry);
                }
            }
        }
        Ok(out)
    }

    fn list_local_dir(&self, dir: &Path) -> BTreeMap<String, (bool, u64, i64)> {
        let mut out = BTreeMap::new();
        let Ok(rd) = std::fs::read_dir(dir) else {
            return out;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if self.ignored(&path, meta.is_dir()) || !(meta.is_dir() || meta.is_file()) {
                continue;
            }
            out.insert(
                entry.file_name().to_string_lossy().into_owned(),
                (meta.is_dir(), meta.len(), mtime_secs(&meta)),
            );
        }
        out
    }

    async fn list_remote_dir(
        &self,
        dir: &str,
    ) -> Result<BTreeMap<String, (bool, u64, i64)>, String> {
        let mut out = BTreeMap::new();
        if self.remote.stat(dir).await?.is_none() {
            return Ok(out);
        }
        for e in self.remote.list(dir).await? {
            let is_dir = e.kind == Kind::Dir;
            if e.kind == Kind::Symlink
                || (!self.force && self.cfg.is_ignored_remote(&e.path, is_dir))
            {
                continue;
            }
            out.insert(e.name, (is_dir, e.size, self.remote_to_local_time(e.mtime)));
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    async fn sync_dir(
        &self,
        local_dir: PathBuf,
        remote_dir: String,
        direction: Direction,
        tasks: &mut Vec<Task>,
        removals: &mut Vec<Removal>,
        summary: &mut Summary,
    ) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Ok(());
        }
        let opts = self.cfg.sync_option;
        let local = self.list_local_dir(&local_dir);
        let remote = self.list_remote_dir(&remote_dir).await?;
        let (src, dst) = match direction {
            Direction::RemoteToLocal => (&remote, &local),
            _ => (&local, &remote),
        };
        let mut seen = HashSet::new();
        for (name, &(src_dir, src_size, src_mtime)) in src {
            seen.insert(name.clone());
            let lpath = local_dir.join(name);
            let rpath = config::join_remote(&remote_dir, name);
            match dst.get(name) {
                Some(&(dst_dir, dst_size, dst_mtime)) => {
                    if opts.ignore_existing {
                        summary.skipped += 1;
                        continue;
                    }
                    if src_dir && dst_dir {
                        Box::pin(self.sync_dir(lpath, rpath, direction, tasks, removals, summary))
                            .await?;
                        continue;
                    }
                    if src_dir != dst_dir {
                        self.ctx.error(format!(
                            "Type mismatch (file vs folder), skipped {}",
                            lpath.display()
                        ));
                        summary.skipped += 1;
                        continue;
                    }
                    // Which side is "from": the sync direction, or the newer side for Both.
                    let mut to_remote = direction != Direction::RemoteToLocal;
                    let (mut from_m, mut to_m, from_s, to_s) =
                        (src_mtime, dst_mtime, src_size, dst_size);
                    if direction == Direction::Both && dst_mtime > src_mtime {
                        to_remote = false;
                        std::mem::swap(&mut from_m, &mut to_m);
                    }
                    if opts.update && from_m <= to_m {
                        summary.skipped += 1;
                        continue;
                    }
                    if from_s == to_s && from_m == to_m {
                        summary.skipped += 1;
                        continue;
                    }
                    // Remote times are already shifted into local time here.
                    tasks.push(if to_remote {
                        Task::Upload {
                            local: lpath,
                            remote: rpath,
                            mtime: from_m,
                        }
                    } else {
                        Task::Download {
                            remote: rpath,
                            local: lpath,
                            mtime: from_m,
                        }
                    });
                }
                None => {
                    if opts.skip_create {
                        summary.skipped += 1;
                        continue;
                    }
                    match direction {
                        Direction::RemoteToLocal => {
                            self.collect_download(&rpath, tasks, summary).await?
                        }
                        _ => {
                            if src_dir {
                                self.collect_upload(&lpath, tasks, summary).await?;
                            } else {
                                tasks.push(Task::Upload {
                                    local: lpath,
                                    remote: rpath,
                                    mtime: src_mtime,
                                });
                            }
                        }
                    }
                }
            }
        }
        for (name, &(is_dir, _, _)) in dst {
            if seen.contains(name) {
                continue;
            }
            let lpath = local_dir.join(name);
            let rpath = config::join_remote(&remote_dir, name);
            match direction {
                Direction::Both => {
                    if !opts.skip_create {
                        self.collect_download(&rpath, tasks, summary).await?;
                    }
                }
                Direction::LocalToRemote if opts.delete => removals.push(Removal::Remote {
                    path: rpath,
                    dir: is_dir,
                }),
                Direction::RemoteToLocal if opts.delete => removals.push(Removal::Local {
                    path: lpath,
                    dir: is_dir,
                }),
                _ => {}
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ execution

    async fn execute(
        &self,
        tasks: Vec<Task>,
        removals: Vec<Removal>,
        mut summary: Summary,
    ) -> Summary {
        let total = tasks.len() + removals.len();
        self.running.fetch_add(1, Ordering::SeqCst);
        self.status(0, total);
        if total > 0 {
            self.ctx.info(format!("{}: {} item(s)", self.label, total));
        }

        let sem = Arc::new(Semaphore::new(self.cfg.concurrency.max(1)));
        let done = Arc::new(AtomicUsize::new(0));
        let mut set: JoinSet<(bool, Result<(), String>)> = JoinSet::new();
        // Create each remote parent folder once, up front, serially.
        let mut parents: Vec<String> = tasks
            .iter()
            .filter_map(|t| match t {
                Task::Upload { remote, .. } => config::remote_parent(remote),
                _ => None,
            })
            .collect();
        parents.sort();
        parents.dedup();
        for parent in parents {
            if let Err(e) = self.remote.mkdir_p(&parent).await {
                self.ctx.error(e);
            }
        }

        for task in tasks {
            if self.cancel.is_cancelled() {
                summary.cancelled = true;
                break;
            }
            let permit = sem.clone().acquire_owned().await.expect("semaphore");
            let remote = self.remote.clone();
            let ctx = self.ctx.clone();
            let recent = self.recent.clone();
            let cancel = self.cancel.clone();
            let use_temp = self.cfg.use_temp_file || self.cfg.open_ssh;
            let offset = self.cfg.remote_time_offset_secs;
            let done = done.clone();
            let this_total = total;
            let app_status = (self.running.clone(), self.label.clone());
            set.spawn(async move {
                let _permit = permit;
                if cancel.is_cancelled() {
                    return (false, Ok(()));
                }
                let result = match &task {
                    Task::Upload {
                        local,
                        remote: rpath,
                        mtime,
                    } => match tokio::fs::read(local).await {
                        Ok(data) => remote
                            .write(rpath, &data, use_temp, Some(mtime + offset))
                            .await
                            .map(|_| ctx.info(format!("↑ {}", rpath))),
                        Err(e) => Err(format!("{}: {e}", local.display())),
                    },
                    Task::Download {
                        remote: rpath,
                        local,
                        mtime,
                    } => match remote.read(rpath).await {
                        Ok(data) => {
                            if let Some(parent) = local.parent() {
                                let _ = std::fs::create_dir_all(parent);
                            }
                            recent.mark(local);
                            match tokio::fs::write(local, &data).await {
                                Ok(()) => {
                                    set_local_mtime(local, *mtime);
                                    recent.mark(local);
                                    ctx.info(format!("↓ {}", rpath));
                                    Ok(())
                                }
                                Err(e) => Err(format!("{}: {e}", local.display())),
                            }
                        }
                        Err(e) => Err(e),
                    },
                };
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                ctx.emit(
                    "sftp-status",
                    Status {
                        running: app_status.0.load(Ordering::SeqCst),
                        label: app_status.1.clone(),
                        done: n,
                        total: this_total,
                    },
                );
                (matches!(task, Task::Upload { .. }), result)
            });
        }
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((true, Ok(()))) => summary.uploaded += 1,
                Ok((false, Ok(()))) => summary.downloaded += 1,
                Ok((_, Err(e))) => fail(&mut summary, e),
                Err(e) => fail(&mut summary, e.to_string()),
            }
        }
        if self.cancel.is_cancelled() {
            summary.cancelled = true;
        }

        if !summary.cancelled {
            for removal in removals {
                let result = match &removal {
                    Removal::Remote { path, dir: true } => self.remote.remove_dir_all(path).await,
                    Removal::Remote { path, dir: false } => self.remote.remove_file(path).await,
                    Removal::Local { path, dir: true } => std::fs::remove_dir_all(path)
                        .map_err(|e| format!("{}: {e}", path.display())),
                    Removal::Local { path, dir: false } => {
                        std::fs::remove_file(path).map_err(|e| format!("{}: {e}", path.display()))
                    }
                };
                match result {
                    Ok(()) => {
                        summary.deleted += 1;
                        let shown = match &removal {
                            Removal::Remote { path, .. } => path.clone(),
                            Removal::Local { path, .. } => path.display().to_string(),
                        };
                        self.ctx.info(format!("✕ {shown}"));
                    }
                    Err(e) => fail(&mut summary, e),
                }
                done.fetch_add(1, Ordering::SeqCst);
            }
        }

        self.running.fetch_sub(1, Ordering::SeqCst);
        self.status(done.load(Ordering::SeqCst), total);
        let msg = format!(
            "{} finished: {} uploaded, {} downloaded, {} deleted, {} skipped, {} failed{}",
            self.label,
            summary.uploaded,
            summary.downloaded,
            summary.deleted,
            summary.skipped,
            summary.failed,
            if summary.cancelled {
                " (cancelled)"
            } else {
                ""
            }
        );
        if summary.failed > 0 {
            self.ctx.error(msg);
        } else {
            self.ctx.info(msg);
        }
        summary
    }
}

fn fail(summary: &mut Summary, e: String) {
    summary.failed += 1;
    if summary.errors.len() < 20 {
        summary.errors.push(e);
    }
}
