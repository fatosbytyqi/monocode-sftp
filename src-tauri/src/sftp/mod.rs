//! SFTP / FTP deployment, modelled on the VS Code SFTP extension
//! (Natizyskunk.sftp): `.vscode/sftp.json`, upload on save, file watcher,
//! remote explorer, sync, diff, profiles, jump hosts and temp-file editing.

mod config;
#[cfg(test)]
mod e2e_tests;
mod ops;
mod prompt;
mod remote;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use globset::{Glob, GlobSet, GlobSetBuilder};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use config::{ConfigSummary, DownloadOnOpen, Protocol, Resolved};
use ops::{Direction, Recent, Run, Summary};
use prompt::Ctx;
use remote::{Entry, Kind, Remote};

type Slot = Arc<Mutex<Option<Arc<Remote>>>>;

struct TempLink {
    workspace: PathBuf,
    index: usize,
    remote: String,
}

#[derive(Default)]
pub struct SftpState {
    ctx: OnceLock<Arc<Ctx>>,
    /// workspace -> config index -> chosen profile (None = no profile).
    profiles: StdMutex<HashMap<PathBuf, HashMap<usize, Option<String>>>>,
    conns: StdMutex<HashMap<String, Slot>>,
    cancel: StdMutex<CancellationToken>,
    temp: StdMutex<HashMap<PathBuf, TempLink>>,
    watchers: StdMutex<HashMap<PathBuf, Vec<notify::RecommendedWatcher>>>,
    recent: Arc<Recent>,
    running: Arc<AtomicUsize>,
}

impl SftpState {
    fn ctx(&self, app: &AppHandle) -> Arc<Ctx> {
        self.ctx
            .get_or_init(|| Arc::new(Ctx::new(app.clone())))
            .clone()
    }

    fn cancel_token(&self) -> CancellationToken {
        self.cancel.lock().unwrap().clone()
    }

    fn configs(&self, workspace: &Path) -> Result<Vec<Resolved>, String> {
        let chosen = self
            .profiles
            .lock()
            .unwrap()
            .get(workspace)
            .cloned()
            .unwrap_or_default();
        config::load(workspace, &chosen)
    }

    fn config(&self, workspace: &Path, index: usize) -> Result<Resolved, String> {
        self.configs(workspace)?
            .into_iter()
            .find(|c| c.index == index)
            .ok_or_else(|| format!("No SFTP config #{index} in {}", workspace.display()))
    }

    /// The config whose context holds `local` (the most specific one wins).
    fn config_for(&self, workspace: &Path, local: &Path) -> Result<Resolved, String> {
        self.configs(workspace)?
            .into_iter()
            .filter(|c| c.contains(local))
            .max_by_key(|c| c.context.components().count())
            .ok_or_else(|| format!("{} is not inside any SFTP context", local.display()))
    }

    async fn remote(&self, ctx: &Arc<Ctx>, cfg: &Resolved) -> Result<Arc<Remote>, String> {
        let slot = {
            let mut conns = self.conns.lock().unwrap();
            conns
                .entry(cfg.connection_key())
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut guard = slot.lock().await;
        if let Some(existing) = guard.as_ref() {
            if !existing.is_closed() {
                return Ok(existing.clone());
            }
            ctx.info(format!(
                "Connection to {} was closed; reconnecting",
                cfg.host
            ));
        }
        let fresh = Arc::new(
            Remote::connect(ctx, cfg)
                .await
                .inspect_err(|e| ctx.error(e))?,
        );
        *guard = Some(fresh.clone());
        Ok(fresh)
    }

    async fn run(
        &self,
        app: &AppHandle,
        cfg: Resolved,
        force: bool,
        label: String,
    ) -> Result<Run, String> {
        let ctx = self.ctx(app);
        let remote = self.remote(&ctx, &cfg).await?;
        Ok(Run {
            ctx,
            remote,
            cfg: Arc::new(cfg),
            cancel: self.cancel_token(),
            recent: self.recent.clone(),
            running: self.running.clone(),
            force,
            label,
        })
    }
}

fn workspace_path(workspace: &str) -> PathBuf {
    crate::fs::expand_home(workspace)
}

/// Nearest folder at or above `path` with `.vscode/sftp.json` or `.monocode/sftp.json`.
fn find_workspace(path: &Path) -> Option<PathBuf> {
    let mut dir = if path.is_dir() {
        Some(path)
    } else {
        path.parent()
    };
    while let Some(d) = dir {
        if config::config_path(d).is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

fn merge(into: &mut Summary, from: Summary) {
    into.uploaded += from.uploaded;
    into.downloaded += from.downloaded;
    into.deleted += from.deleted;
    into.skipped += from.skipped;
    into.failed += from.failed;
    into.cancelled |= from.cancelled;
    into.errors.extend(from.errors);
}

// ------------------------------------------------------------------- watcher

fn start_watchers(app: &AppHandle, state: &SftpState, workspace: &Path, configs: &[Resolved]) {
    let mut all = state.watchers.lock().unwrap();
    all.remove(workspace);
    let mut list = Vec::new();
    for cfg in configs {
        let Some(w) = &cfg.watcher else { continue };
        if !w.auto_upload && !w.auto_delete {
            continue;
        }
        let glob: GlobSet = {
            let mut b = GlobSetBuilder::new();
            let mut bad = false;
            for pattern in &w.files {
                match Glob::new(pattern) {
                    Ok(g) => {
                        b.add(g);
                    }
                    Err(e) => {
                        state
                            .ctx(app)
                            .error(format!("watcher.files \"{pattern}\": {e}"));
                        bad = true;
                    }
                }
            }
            if bad {
                continue;
            }
            b.build().unwrap_or_else(|_| GlobSet::empty())
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<notify::Event>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                state.ctx(app).error(format!("Watcher: {e}"));
                continue;
            }
        };
        if let Err(e) = watcher.watch(&cfg.context, RecursiveMode::Recursive) {
            state
                .ctx(app)
                .error(format!("Watcher {}: {e}", cfg.context.display()));
            continue;
        }
        state.ctx(app).info(format!(
            "Watching {} for {} (upload: {}, delete: {})",
            cfg.context.display(),
            w.files.join(", "),
            w.auto_upload,
            w.auto_delete
        ));
        let app = app.clone();
        let workspace = workspace.to_path_buf();
        let index = cfg.index;
        let context = cfg.context.clone();
        let (auto_upload, auto_delete) = (w.auto_upload, w.auto_delete);
        tauri::async_runtime::spawn(async move {
            loop {
                let Some(first) = rx.recv().await else { break };
                let mut events = vec![first];
                tokio::time::sleep(Duration::from_millis(300)).await;
                while let Ok(e) = rx.try_recv() {
                    events.push(e);
                }
                let mut changed: Vec<PathBuf> = Vec::new();
                let mut removed: Vec<PathBuf> = Vec::new();
                for event in events {
                    for path in event.paths {
                        let Ok(rel) = path.strip_prefix(&context) else {
                            continue;
                        };
                        if !glob.is_match(rel) {
                            continue;
                        }
                        match event.kind {
                            EventKind::Remove(_) => removed.push(path),
                            EventKind::Create(_) | EventKind::Modify(_) => {
                                if path.exists() {
                                    changed.push(path);
                                } else {
                                    removed.push(path);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                changed.sort();
                changed.dedup();
                removed.sort();
                removed.dedup();
                let state = app.state::<SftpState>();
                changed.retain(|p| p.is_file() && !state.recent.is_recent(p));
                let Ok(cfg) = state.config(&workspace, index) else {
                    continue;
                };
                changed.retain(|p| !cfg.is_ignored(p, false));
                removed.retain(|p| !cfg.is_ignored(p, false));
                if auto_upload && !changed.is_empty() {
                    for p in &changed {
                        state.recent.mark(p);
                    }
                    if let Ok(run) = state
                        .run(&app, cfg.clone(), false, "Watcher upload".into())
                        .await
                    {
                        run.upload(&changed).await;
                    }
                }
                if auto_delete && !removed.is_empty() {
                    let remotes: Vec<String> =
                        removed.iter().filter_map(|p| cfg.to_remote(p)).collect();
                    if let Ok(run) = state
                        .run(&app, cfg.clone(), false, "Watcher delete".into())
                        .await
                    {
                        run.delete_remote(&remotes).await;
                    }
                }
            }
        });
        list.push(watcher);
    }
    if !list.is_empty() {
        all.insert(workspace.to_path_buf(), list);
    }
}

// ------------------------------------------------------------------ commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigsResponse {
    config_path: String,
    exists: bool,
    configs: Vec<ConfigSummary>,
    error: Option<String>,
}

#[tauri::command]
pub async fn sftp_configs(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
) -> Result<ConfigsResponse, String> {
    let root = workspace_path(&workspace);
    let path = config::config_path(&root);
    let exists = path.is_file();
    match state.configs(&root) {
        Ok(mut configs) => {
            start_watchers(&app, &state, &root, &configs);
            configs.sort_by(|a, b| a.order.cmp(&b.order).then(a.name.cmp(&b.name)));
            Ok(ConfigsResponse {
                config_path: path.to_string_lossy().into_owned(),
                exists,
                configs: configs.iter().map(ConfigSummary::from).collect(),
                error: None,
            })
        }
        Err(e) => {
            state.watchers.lock().unwrap().remove(&root);
            Ok(ConfigsResponse {
                config_path: path.to_string_lossy().into_owned(),
                exists,
                configs: vec![],
                error: Some(e),
            })
        }
    }
}

#[tauri::command]
pub async fn sftp_init_config(workspace: String) -> Result<String, String> {
    let root = workspace_path(&workspace);
    let path = config::config_path(&root);
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, config::TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sftp_set_profile(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
    profile: Option<String>,
) -> Result<(), String> {
    let root = workspace_path(&workspace);
    state
        .profiles
        .lock()
        .unwrap()
        .entry(root)
        .or_default()
        .insert(index, profile.clone());
    state.ctx(&app).info(format!(
        "Profile: {}",
        profile.as_deref().unwrap_or("(none)")
    ));
    Ok(())
}

/// Upload local files/folders. Each path goes to the config whose context holds it.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    paths: Vec<String>,
    force: Option<bool>,
    all_profiles: Option<bool>,
) -> Result<Summary, String> {
    let root = workspace_path(&workspace);
    let force = force.unwrap_or(false);
    let mut groups: HashMap<usize, (Resolved, Vec<PathBuf>)> = HashMap::new();
    for p in paths {
        let local = PathBuf::from(&p);
        let cfg = state.config_for(&root, &local)?;
        groups
            .entry(cfg.index)
            .or_insert_with(|| (cfg, vec![]))
            .1
            .push(local);
    }
    let mut summary = Summary::default();
    for (_, (cfg, locals)) in groups {
        let targets: Vec<Resolved> = if all_profiles.unwrap_or(false) && !cfg.profiles.is_empty() {
            let mut out = Vec::new();
            for profile in &cfg.profiles {
                let mut chosen = HashMap::new();
                chosen.insert(cfg.index, Some(profile.clone()));
                let c = config::load(&root, &chosen)?
                    .into_iter()
                    .find(|c| c.index == cfg.index)
                    .ok_or("config disappeared")?;
                out.push(c);
            }
            out
        } else {
            vec![cfg]
        };
        for target in targets {
            let label = match &target.active_profile {
                Some(p) => format!("Upload to {} [{p}]", target.name),
                None => format!("Upload to {}", target.name),
            };
            let run = state.run(&app, target, force, label).await?;
            merge(&mut summary, run.upload(&locals).await);
        }
    }
    Ok(summary)
}

/// Download the remote counterparts of local files/folders.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    paths: Vec<String>,
    force: Option<bool>,
) -> Result<Summary, String> {
    let root = workspace_path(&workspace);
    let mut summary = Summary::default();
    for p in paths {
        let local = PathBuf::from(&p);
        let cfg = state.config_for(&root, &local)?;
        let remote = cfg.to_remote(&local).ok_or("outside context")?;
        let label = format!("Download from {}", cfg.name);
        let run = state.run(&app, cfg, force.unwrap_or(false), label).await?;
        merge(&mut summary, run.download(&[remote]).await);
    }
    Ok(summary)
}

#[tauri::command]
pub async fn sftp_download_remote(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
    remote_paths: Vec<String>,
    force: Option<bool>,
) -> Result<Summary, String> {
    let root = workspace_path(&workspace);
    let cfg = state.config(&root, index)?;
    let label = format!("Download from {}", cfg.name);
    let run = state.run(&app, cfg, force.unwrap_or(false), label).await?;
    Ok(run.download(&remote_paths).await)
}

#[tauri::command]
pub async fn sftp_sync(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    path: Option<String>,
    index: Option<usize>,
    direction: Direction,
) -> Result<Summary, String> {
    let root = workspace_path(&workspace);
    let (cfg, local) = match (path, index) {
        (Some(p), _) => {
            let local = PathBuf::from(p);
            (state.config_for(&root, &local)?, local)
        }
        (None, Some(i)) => {
            let cfg = state.config(&root, i)?;
            let ctx_path = cfg.context.clone();
            (cfg, ctx_path)
        }
        (None, None) => return Err("sftp_sync needs a path or a config index".into()),
    };
    if !local.is_dir() {
        // Syncing a single file is an upload or a download.
        let remote = cfg.to_remote(&local).ok_or("outside context")?;
        let run = state.run(&app, cfg, false, "Sync file".into()).await?;
        return Ok(match direction {
            Direction::RemoteToLocal => run.download(&[remote]).await,
            _ => run.upload(&[local]).await,
        });
    }
    let label = match direction {
        Direction::LocalToRemote => format!("Sync local → {}", cfg.name),
        Direction::RemoteToLocal => format!("Sync {} → local", cfg.name),
        Direction::Both => format!("Sync both ways with {}", cfg.name),
    };
    let run = state.run(&app, cfg, false, label).await?;
    Ok(run.sync(&local, direction).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResponse {
    path: String,
    entries: Vec<Entry>,
}

#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
    remote_path: Option<String>,
) -> Result<ListResponse, String> {
    let root = workspace_path(&workspace);
    let cfg = state.config(&root, index)?;
    let ctx = state.ctx(&app);
    let remote = state.remote(&ctx, &cfg).await?;
    let path = remote_path.unwrap_or_else(|| cfg.remote_path.clone());
    let exclude = {
        let mut b = GlobSetBuilder::new();
        for pattern in &cfg.files_exclude {
            if let Ok(g) = Glob::new(pattern) {
                b.add(g);
            }
        }
        b.build().unwrap_or_else(|_| GlobSet::empty())
    };
    let base = cfg.remote_path.trim_end_matches('/').to_string();
    let mut entries: Vec<Entry> = remote
        .list(&path)
        .await
        .inspect_err(|e| ctx.error(e.clone()))?
        .into_iter()
        .filter(|e| {
            let rel = e
                .path
                .strip_prefix(&base)
                .unwrap_or(&e.path)
                .trim_start_matches('/');
            !exclude.is_match(&e.name) && !exclude.is_match(rel)
        })
        .collect();
    entries.sort_by(|a, b| {
        (b.kind == Kind::Dir)
            .cmp(&(a.kind == Kind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(ListResponse { path, entries })
}

#[tauri::command]
pub async fn sftp_delete_remote(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: Option<usize>,
    remote_paths: Option<Vec<String>>,
    local_paths: Option<Vec<String>>,
) -> Result<Summary, String> {
    let root = workspace_path(&workspace);
    let mut summary = Summary::default();
    if let (Some(i), Some(remotes)) = (index, remote_paths) {
        let cfg = state.config(&root, i)?;
        let run = state.run(&app, cfg, true, "Delete remote".into()).await?;
        merge(&mut summary, run.delete_remote(&remotes).await);
    }
    for p in local_paths.unwrap_or_default() {
        let local = PathBuf::from(p);
        let cfg = state.config_for(&root, &local)?;
        let remote = cfg.to_remote(&local).ok_or("outside context")?;
        let run = state.run(&app, cfg, true, "Delete remote".into()).await?;
        merge(&mut summary, run.delete_remote(&[remote]).await);
    }
    Ok(summary)
}

#[tauri::command]
pub async fn sftp_remote_create(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
    remote_path: String,
    dir: bool,
) -> Result<(), String> {
    let cfg = state.config(&workspace_path(&workspace), index)?;
    let ctx = state.ctx(&app);
    let remote = state.remote(&ctx, &cfg).await?;
    if remote.stat(&remote_path).await?.is_some() {
        return Err(format!("{remote_path} already exists"));
    }
    if dir {
        remote.mkdir_p(&remote_path).await?;
    } else {
        if let Some(parent) = config::remote_parent(&remote_path) {
            remote.mkdir_p(&parent).await?;
        }
        remote.write(&remote_path, b"", false, None).await?;
    }
    ctx.info(format!("Created {remote_path}"));
    Ok(())
}

#[tauri::command]
pub async fn sftp_remote_rename(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
    from: String,
    to: String,
) -> Result<(), String> {
    let cfg = state.config(&workspace_path(&workspace), index)?;
    let ctx = state.ctx(&app);
    let remote = state.remote(&ctx, &cfg).await?;
    remote.rename(&from, &to).await?;
    ctx.info(format!("Renamed {from} → {to}"));
    Ok(())
}

/// Open a remote file. `temp: true` opens a cached copy whose saves upload
/// back to the server ("temp file support"); otherwise the file is downloaded
/// into the project ("Edit in Local").
#[tauri::command]
pub async fn sftp_open_remote(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
    remote_path: String,
    temp: bool,
) -> Result<String, String> {
    let root = workspace_path(&workspace);
    let cfg = state.config(&root, index)?;
    let ctx = state.ctx(&app);
    let remote = state.remote(&ctx, &cfg).await?;
    let data = remote
        .read(&remote_path)
        .await
        .inspect_err(|e| ctx.error(e.clone()))?;
    let local = if temp || cfg.to_local(&remote_path).is_none() {
        let base = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("sftp-temp");
        let key = {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(format!("{}|{}", cfg.connection_key(), remote_path));
            digest
                .iter()
                .take(8)
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        base.join(key).join(config::remote_name(&remote_path))
    } else {
        cfg.to_local(&remote_path).unwrap()
    };
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    state.recent.mark(&local);
    std::fs::write(&local, data).map_err(|e| e.to_string())?;
    state.recent.mark(&local);
    if temp || cfg.to_local(&remote_path).is_none() {
        state.temp.lock().unwrap().insert(
            local.clone(),
            TempLink {
                workspace: root,
                index,
                remote: remote_path.clone(),
            },
        );
    }
    ctx.info(format!("Opened {remote_path}"));
    Ok(local.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    local: String,
    remote: Option<String>,
    remote_path: String,
    binary: bool,
}

#[tauri::command]
pub async fn sftp_diff(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    path: String,
) -> Result<DiffResponse, String> {
    let root = workspace_path(&workspace);
    let local = PathBuf::from(&path);
    let cfg = state.config_for(&root, &local)?;
    let remote_path = cfg.to_remote(&local).ok_or("outside context")?;
    let ctx = state.ctx(&app);
    let remote = state.remote(&ctx, &cfg).await?;
    let local_bytes = std::fs::read(&local).unwrap_or_default();
    let remote_bytes = match remote.stat(&remote_path).await? {
        Some(_) => Some(remote.read(&remote_path).await?),
        None => None,
    };
    let binary = local_bytes.contains(&0) || remote_bytes.as_ref().is_some_and(|b| b.contains(&0));
    Ok(DiffResponse {
        local: String::from_utf8_lossy(&local_bytes).into_owned(),
        remote: remote_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        remote_path,
        binary,
    })
}

/// Called after every editor save. Uploads temp copies of remote files, and
/// project files when `uploadOnSave` is on.
#[tauri::command]
pub async fn sftp_on_save(
    app: AppHandle,
    state: State<'_, SftpState>,
    path: String,
) -> Result<Option<Summary>, String> {
    let local = PathBuf::from(&path);
    let link = state
        .temp
        .lock()
        .unwrap()
        .get(&local)
        .map(|l| (l.workspace.clone(), l.index, l.remote.clone()));
    if let Some((root, index, remote_path)) = link {
        let cfg = state.config(&root, index)?;
        let ctx = state.ctx(&app);
        let remote = state.remote(&ctx, &cfg).await?;
        let data = std::fs::read(&local).map_err(|e| e.to_string())?;
        remote
            .write(&remote_path, &data, cfg.use_temp_file || cfg.open_ssh, None)
            .await
            .inspect_err(|e| ctx.error(e.clone()))?;
        ctx.info(format!("↑ {remote_path}"));
        return Ok(Some(Summary {
            uploaded: 1,
            ..Default::default()
        }));
    }
    let Some(root) = find_workspace(&local) else {
        return Ok(None);
    };
    if config::is_config_file(&root, &local) {
        let _ = app.emit("sftp-config-changed", root.to_string_lossy().to_string());
        return Ok(None);
    }
    let Ok(cfg) = state.config_for(&root, &local) else {
        return Ok(None);
    };
    if !cfg.upload_on_save || cfg.is_ignored(&local, false) {
        return Ok(None);
    }
    state.recent.mark(&local);
    let label = format!("Upload on save to {}", cfg.name);
    let run = state.run(&app, cfg, false, label).await?;
    Ok(Some(run.upload(&[local]).await))
}

/// What to do when a project file opens: "off", "on" or "confirm".
#[tauri::command]
pub async fn sftp_on_open(
    state: State<'_, SftpState>,
    path: String,
) -> Result<DownloadOnOpen, String> {
    let local = PathBuf::from(&path);
    let Some(root) = find_workspace(&local) else {
        return Ok(DownloadOnOpen::Off);
    };
    match state.config_for(&root, &local) {
        Ok(cfg) if !cfg.is_ignored(&local, false) => Ok(cfg.download_on_open),
        _ => Ok(DownloadOnOpen::Off),
    }
}

#[tauri::command]
pub async fn sftp_workspace_of(path: String) -> Result<Option<String>, String> {
    Ok(find_workspace(Path::new(&path)).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn sftp_cancel_all(app: AppHandle, state: State<'_, SftpState>) -> Result<(), String> {
    let old = std::mem::take(&mut *state.cancel.lock().unwrap());
    old.cancel();
    state.ctx(&app).info("Cancelled all transfers");
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect_all(
    app: AppHandle,
    state: State<'_, SftpState>,
) -> Result<(), String> {
    let slots: Vec<Slot> = state
        .conns
        .lock()
        .unwrap()
        .drain()
        .map(|(_, s)| s)
        .collect();
    for slot in slots {
        if let Some(remote) = slot.lock().await.take() {
            remote.close().await;
        }
    }
    state.ctx(&app).info("Disconnected");
    Ok(())
}

/// Shell command for "Open SSH in Terminal".
#[tauri::command]
pub async fn sftp_ssh_command(
    state: State<'_, SftpState>,
    workspace: String,
    index: usize,
) -> Result<String, String> {
    let cfg = state.config(&workspace_path(&workspace), index)?;
    if cfg.protocol != Protocol::Sftp {
        return Err("Open SSH in Terminal needs an sftp config".into());
    }
    let quote = |s: &str| {
        if s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._-/:~".contains(c))
        {
            s.to_string()
        } else {
            format!("'{}'", s.replace('\'', "'\\''"))
        }
    };
    let mut stages = vec![(cfg.username.clone(), cfg.host.clone(), cfg.port)];
    stages.extend(
        cfg.hops
            .iter()
            .map(|h| (h.username.clone(), h.host.clone(), h.port)),
    );
    let (user, host, port) = stages.pop().expect("one stage");
    let mut parts = vec!["ssh".to_string(), "-t".into()];
    if let Some(key) = &cfg.private_key_path {
        if stages.is_empty() {
            parts.push("-i".into());
            parts.push(quote(&key.to_string_lossy()));
        }
    }
    if !stages.is_empty() {
        let jumps: Vec<String> = stages
            .iter()
            .map(|(u, h, p)| format!("{u}@{h}:{p}"))
            .collect();
        parts.push("-J".into());
        parts.push(quote(&jumps.join(",")));
    }
    if port != 22 {
        parts.push("-p".into());
        parts.push(port.to_string());
    }
    parts.push(quote(&format!("{user}@{host}")));
    parts.push(
        cfg.ssh_custom_params
            .replace("${remotePath}", &cfg.remote_path),
    );
    Ok(parts.join(" "))
}

#[tauri::command]
pub async fn sftp_prompt_reply(
    app: AppHandle,
    state: State<'_, SftpState>,
    id: String,
    value: Option<String>,
) -> Result<(), String> {
    state.ctx(&app).reply(&id, value);
    Ok(())
}

// ------------------------------------------------------------- setup form

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawConfigResponse {
    path: String,
    exists: bool,
    /// The file uses comments, which saving from the form drops.
    has_comments: bool,
    entries: Vec<serde_json::Value>,
    error: Option<String>,
}

/// The config entries as written in the file, for the setup form.
#[tauri::command]
pub async fn sftp_read_raw(workspace: String) -> Result<RawConfigResponse, String> {
    let root = workspace_path(&workspace);
    let path = config::config_path(&root);
    let text = std::fs::read_to_string(&path).ok();
    let has_comments = text
        .as_deref()
        .is_some_and(|t| t.contains("//") || t.contains("/*"));
    let (entries, error) = match config::read_raw(&root) {
        Ok(Some(entries)) => (
            entries.into_iter().map(serde_json::Value::Object).collect(),
            None,
        ),
        Ok(None) => (vec![], None),
        Err(e) => (vec![], Some(e)),
    };
    Ok(RawConfigResponse {
        path: path.to_string_lossy().into_owned(),
        exists: text.is_some(),
        has_comments,
        entries,
        error,
    })
}

/// Save entries from the setup form. Writes `.vscode/sftp.json` when the
/// project already has one, otherwise `.monocode/sftp.json`.
#[tauri::command]
pub async fn sftp_write_raw(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    entries: Vec<serde_json::Value>,
) -> Result<String, String> {
    let root = workspace_path(&workspace);
    if entries.iter().any(|e| !e.is_object()) {
        return Err("Each SFTP config must be an object".into());
    }
    let path = config::config_path(&root);
    let value = if entries.len() == 1 {
        entries.into_iter().next().unwrap()
    } else {
        serde_json::Value::Array(entries)
    };
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n";
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    // Settings may have changed host or credentials; start fresh.
    let slots: Vec<Slot> = state
        .conns
        .lock()
        .unwrap()
        .drain()
        .map(|(_, s)| s)
        .collect();
    for slot in slots {
        if let Some(remote) = slot.lock().await.take() {
            remote.close().await;
        }
    }
    if let Ok(configs) = state.configs(&root) {
        start_watchers(&app, &state, &root, &configs);
    }
    let _ = app.emit("sftp-config-changed", root.to_string_lossy().to_string());
    state.ctx(&app).info(format!("Saved {}", path.display()));
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    ok: bool,
    message: String,
    details: Vec<String>,
}

/// Connect with an unsaved config entry and check `remotePath`.
#[tauri::command]
pub async fn sftp_test_connection(
    app: AppHandle,
    state: State<'_, SftpState>,
    workspace: String,
    entry: serde_json::Value,
    profile: Option<String>,
) -> Result<TestResult, String> {
    let root = workspace_path(&workspace);
    let map = entry.as_object().ok_or("The config must be an object")?;
    let cfg = match config::resolve_unsaved(&root, map, profile) {
        Ok(cfg) => cfg,
        Err(e) => {
            return Ok(TestResult {
                ok: false,
                message: e,
                details: vec![],
            })
        }
    };
    let ctx = state.ctx(&app);
    let mut details = vec![format!(
        "{:?} {}@{}:{}{}",
        cfg.protocol,
        cfg.username,
        cfg.host,
        cfg.port,
        if cfg.hops.is_empty() {
            String::new()
        } else {
            format!(" via {} hop(s)", cfg.hops.len())
        }
    )
    .to_lowercase()];
    let started = std::time::Instant::now();
    let remote = match Remote::connect(&ctx, &cfg).await {
        Ok(r) => r,
        Err(e) => {
            return Ok(TestResult {
                ok: false,
                message: format!("Connection failed: {e}"),
                details,
            })
        }
    };
    details.push(format!(
        "Connected and authenticated in {} ms",
        started.elapsed().as_millis()
    ));
    let result = match remote.stat(&cfg.remote_path).await {
        Ok(Some(entry)) if entry.kind == Kind::Dir => match remote.list(&cfg.remote_path).await {
            Ok(items) => {
                details.push(format!(
                    "Remote path {} exists ({} item{})",
                    cfg.remote_path,
                    items.len(),
                    if items.len() == 1 { "" } else { "s" }
                ));
                TestResult {
                    ok: true,
                    message: "Connection works".into(),
                    details,
                }
            }
            Err(e) => TestResult {
                ok: false,
                message: format!("Connected, but can't list {}: {e}", cfg.remote_path),
                details,
            },
        },
        Ok(Some(_)) => TestResult {
            ok: false,
            message: format!("Connected, but {} is a file, not a folder", cfg.remote_path),
            details,
        },
        Ok(None) => TestResult {
            ok: false,
            message: format!(
                "Connected, but remote path {} does not exist",
                cfg.remote_path
            ),
            details,
        },
        Err(e) => TestResult {
            ok: false,
            message: format!("Connected, but checking {} failed: {e}", cfg.remote_path),
            details,
        },
    };
    remote.close().await;
    ctx.info(format!("Test connection: {}", result.message));
    Ok(result)
}
