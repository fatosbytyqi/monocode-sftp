//! Remote file systems: SFTP over russh (with jump hosts), FTP/FTPS over
//! suppaftp, and `local` (a plain folder, handy for mirroring to a mount).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh::client::{self, Handle};
use russh::keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Preferred};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use suppaftp::tokio::{AsyncNativeTlsConnector, AsyncNativeTlsFtpStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::config::{
    self, Algorithms, FtpSecure, Hop, InteractiveAuth, Passphrase, Protocol, Resolved,
};
use super::prompt::Ctx;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    Symlink,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    /// Seconds since epoch, as reported by the server.
    pub mtime: i64,
}

pub enum Remote {
    Sftp(SftpRemote),
    Ftp(FtpRemote),
    Local,
}

pub struct SftpRemote {
    sftp: SftpSession,
    /// Every session in the hop chain, kept alive; the last runs SFTP.
    handles: Vec<Handle<SshHandler>>,
}

pub struct FtpRemote {
    stream: Mutex<AsyncNativeTlsFtpStream>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn local_path(remote: &str) -> PathBuf {
    PathBuf::from(remote)
}

impl Remote {
    pub async fn connect(ctx: &Arc<Ctx>, cfg: &Resolved) -> Result<Remote, String> {
        match cfg.protocol {
            Protocol::Local => Ok(Remote::Local),
            Protocol::Ftp => Ok(Remote::Ftp(FtpRemote::connect(ctx, cfg).await?)),
            Protocol::Sftp => Ok(Remote::Sftp(SftpRemote::connect(ctx, cfg).await?)),
        }
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Remote::Sftp(s) => s.handles.iter().any(|h| h.is_closed()),
            _ => false,
        }
    }

    pub async fn close(&self) {
        match self {
            Remote::Sftp(s) => {
                let _ = s.sftp.close().await;
                for h in s.handles.iter().rev() {
                    let _ = h
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                }
            }
            Remote::Ftp(f) => {
                let _ = f.stream.lock().await.quit().await;
            }
            Remote::Local => {}
        }
    }

    pub async fn list(&self, dir: &str) -> Result<Vec<Entry>, String> {
        match self {
            Remote::Sftp(s) => {
                let entries = s
                    .sftp
                    .read_dir(dir)
                    .await
                    .map_err(|e| format!("{dir}: {e}"))?;
                let mut out = Vec::new();
                for entry in entries {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let meta = entry.metadata();
                    let kind = if meta.is_dir() {
                        Kind::Dir
                    } else if meta.is_symlink() {
                        Kind::Symlink
                    } else {
                        Kind::File
                    };
                    let path = config::join_remote(dir, &name);
                    let kind = if kind == Kind::Symlink {
                        // Follow links so linked folders browse and sync as folders.
                        match s.sftp.metadata(path.clone()).await {
                            Ok(target) if target.is_dir() => Kind::Dir,
                            Ok(_) => Kind::File,
                            Err(_) => Kind::Symlink,
                        }
                    } else {
                        kind
                    };
                    out.push(Entry {
                        name,
                        path,
                        kind,
                        size: meta.size.unwrap_or(0),
                        mtime: meta.mtime.map(i64::from).unwrap_or(0),
                    });
                }
                Ok(out)
            }
            Remote::Ftp(f) => f.list(dir).await,
            Remote::Local => {
                let mut out = Vec::new();
                let mut rd = tokio::fs::read_dir(local_path(dir))
                    .await
                    .map_err(|e| format!("{dir}: {e}"))?;
                while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
                    let meta = match tokio::fs::metadata(entry.path()).await {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    let name = entry.file_name().to_string_lossy().into_owned();
                    out.push(Entry {
                        path: config::join_remote(dir, &name),
                        name,
                        kind: if meta.is_dir() { Kind::Dir } else { Kind::File },
                        size: meta.len(),
                        mtime: mtime_secs(&meta),
                    });
                }
                Ok(out)
            }
        }
    }

    pub async fn stat(&self, path: &str) -> Result<Option<Entry>, String> {
        let name = config::remote_name(path).to_string();
        match self {
            Remote::Sftp(s) => match s.sftp.metadata(path).await {
                Ok(meta) => Ok(Some(Entry {
                    name,
                    path: path.into(),
                    kind: if meta.is_dir() { Kind::Dir } else { Kind::File },
                    size: meta.size.unwrap_or(0),
                    mtime: meta.mtime.map(i64::from).unwrap_or(0),
                })),
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
                {
                    Ok(None)
                }
                Err(e) => Err(format!("{path}: {e}")),
            },
            Remote::Ftp(f) => f.stat(path).await,
            Remote::Local => match tokio::fs::metadata(local_path(path)).await {
                Ok(meta) => Ok(Some(Entry {
                    name,
                    path: path.into(),
                    kind: if meta.is_dir() { Kind::Dir } else { Kind::File },
                    size: meta.len(),
                    mtime: mtime_secs(&meta),
                })),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("{path}: {e}")),
            },
        }
    }

    pub async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        match self {
            Remote::Sftp(s) => s.sftp.read(path).await.map_err(|e| format!("{path}: {e}")),
            Remote::Ftp(f) => f.read(path).await,
            Remote::Local => tokio::fs::read(local_path(path))
                .await
                .map_err(|e| format!("{path}: {e}")),
        }
    }

    /// Write a file, optionally through a temp name then rename, so a web
    /// server never serves a half-written file (`useTempFile` / `openSsh`).
    pub async fn write(
        &self,
        path: &str,
        data: &[u8],
        use_temp_file: bool,
        mtime: Option<i64>,
    ) -> Result<(), String> {
        let target = if use_temp_file {
            let parent = config::remote_parent(path).unwrap_or_else(|| "/".into());
            config::join_remote(
                &parent,
                &format!(
                    ".{}.{}.tmp",
                    config::remote_name(path),
                    uuid::Uuid::new_v4().simple()
                ),
            )
        } else {
            path.to_string()
        };
        match self {
            Remote::Sftp(s) => {
                let mut file = s
                    .sftp
                    .create(target.clone())
                    .await
                    .map_err(|e| format!("{path}: {e}"))?;
                file.write_all(data)
                    .await
                    .map_err(|e| format!("{path}: {e}"))?;
                file.shutdown().await.map_err(|e| format!("{path}: {e}"))?;
                if use_temp_file {
                    // SFTPv3 rename refuses to overwrite; replace the old file.
                    if s.sftp.rename(target.clone(), path).await.is_err() {
                        let _ = s.sftp.remove_file(path).await;
                        s.sftp
                            .rename(target.clone(), path)
                            .await
                            .map_err(|e| format!("{path}: {e}"))?;
                    }
                }
                if let Some(mtime) = mtime {
                    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
                    attrs.mtime = Some(mtime as u32);
                    attrs.atime = Some(now_secs() as u32);
                    let _ = s.sftp.set_metadata(path, attrs).await;
                }
                Ok(())
            }
            Remote::Ftp(f) => {
                f.write(&target, data).await?;
                if use_temp_file {
                    let mut ftp = f.stream.lock().await;
                    if ftp.rename(&target, &path.to_string()).await.is_err() {
                        let _ = ftp.rm(path).await;
                        ftp.rename(&target, &path.to_string())
                            .await
                            .map_err(|e| format!("{path}: {e}"))?;
                    }
                }
                Ok(())
            }
            Remote::Local => {
                let target_path = local_path(&target);
                tokio::fs::write(&target_path, data)
                    .await
                    .map_err(|e| format!("{path}: {e}"))?;
                if use_temp_file {
                    tokio::fs::rename(&target_path, local_path(path))
                        .await
                        .map_err(|e| format!("{path}: {e}"))?;
                }
                if let Some(mtime) = mtime {
                    set_local_mtime(&local_path(path), mtime);
                }
                Ok(())
            }
        }
    }

    pub async fn mkdir_p(&self, path: &str) -> Result<(), String> {
        if path.is_empty() || path == "/" {
            return Ok(());
        }
        if let Some(Entry {
            kind: Kind::Dir, ..
        }) = self.stat(path).await?
        {
            return Ok(());
        }
        if let Some(parent) = config::remote_parent(path) {
            Box::pin(self.mkdir_p(&parent)).await?;
        }
        let result = match self {
            Remote::Sftp(s) => s.sftp.create_dir(path).await.map_err(|e| e.to_string()),
            Remote::Ftp(f) => f
                .stream
                .lock()
                .await
                .mkdir(path)
                .await
                .map_err(|e| e.to_string()),
            Remote::Local => tokio::fs::create_dir(local_path(path))
                .await
                .map_err(|e| e.to_string()),
        };
        match result {
            Ok(()) => Ok(()),
            // Another task may have created it meanwhile.
            Err(e) => match self.stat(path).await? {
                Some(Entry {
                    kind: Kind::Dir, ..
                }) => Ok(()),
                _ => Err(format!("{path}: {e}")),
            },
        }
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        match self {
            Remote::Sftp(s) => s
                .sftp
                .remove_file(path)
                .await
                .map_err(|e| format!("{path}: {e}")),
            Remote::Ftp(f) => f
                .stream
                .lock()
                .await
                .rm(path)
                .await
                .map_err(|e| format!("{path}: {e}")),
            Remote::Local => tokio::fs::remove_file(local_path(path))
                .await
                .map_err(|e| format!("{path}: {e}")),
        }
    }

    pub async fn remove_dir_all(&self, path: &str) -> Result<(), String> {
        if path.is_empty() || path == "/" {
            return Err("Refusing to delete the remote root".into());
        }
        if let Remote::Local = self {
            return tokio::fs::remove_dir_all(local_path(path))
                .await
                .map_err(|e| format!("{path}: {e}"));
        }
        for entry in self.list(path).await? {
            if entry.kind == Kind::Dir {
                Box::pin(self.remove_dir_all(&entry.path)).await?;
            } else {
                self.remove_file(&entry.path).await?;
            }
        }
        match self {
            Remote::Sftp(s) => s
                .sftp
                .remove_dir(path)
                .await
                .map_err(|e| format!("{path}: {e}")),
            Remote::Ftp(f) => f
                .stream
                .lock()
                .await
                .rmdir(path)
                .await
                .map_err(|e| format!("{path}: {e}")),
            Remote::Local => unreachable!(),
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Remote::Sftp(s) => s.sftp.rename(from, to).await.map_err(|e| e.to_string()),
            Remote::Ftp(f) => f
                .stream
                .lock()
                .await
                .rename(from, to)
                .await
                .map_err(|e| e.to_string()),
            Remote::Local => tokio::fs::rename(local_path(from), local_path(to))
                .await
                .map_err(|e| e.to_string()),
        }
    }
}

pub fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn set_local_mtime(path: &Path, secs: i64) {
    if secs <= 0 {
        return;
    }
    let time = UNIX_EPOCH + Duration::from_secs(secs as u64);
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(time);
    }
}

// ---------------------------------------------------------------- SSH / SFTP

pub struct SshHandler {
    ctx: Arc<Ctx>,
    host: String,
    port: u16,
    rejection: Arc<StdMutex<Option<String>>>,
}

fn known_hosts_file() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MONOCODE_SFTP_KNOWN_HOSTS") {
        return Some(PathBuf::from(path));
    }
    crate::dirs_home().map(|h| PathBuf::from(h).join(".ssh").join("known_hosts"))
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                keys::PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let Some(path) = known_hosts_file() else {
            return Ok(false);
        };
        match keys::check_known_hosts_path(&self.host, self.port, &key, &path) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let fingerprint = key.fingerprint(keys::HashAlg::Sha256);
                let trust = self
                    .ctx
                    .confirm(
                        "Unknown host",
                        &format!(
                            "The authenticity of {}:{} can't be established.\n{} key fingerprint is {}.\nTrust this host and add it to ~/.ssh/known_hosts?",
                            self.host,
                            self.port,
                            key.algorithm().as_str(),
                            fingerprint
                        ),
                    )
                    .await;
                if !trust {
                    *self.rejection.lock().unwrap() =
                        Some(format!("Host key for {} was not trusted", self.host));
                    return Ok(false);
                }
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                if let Err(e) =
                    keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, &path)
                {
                    self.ctx.error(format!("Could not update known_hosts: {e}"));
                }
                Ok(true)
            }
            Err(keys::Error::KeyChanged { line }) => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "HOST KEY CHANGED for {}:{} (known_hosts line {line}). Refusing to connect; remove the old entry if the change is expected.",
                    self.host, self.port
                ));
                Ok(false)
            }
            Err(e) => {
                *self.rejection.lock().unwrap() = Some(format!("known_hosts: {e}"));
                Ok(false)
            }
        }
    }
}

/// One machine in the connection chain.
struct Stage {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key_path: Option<PathBuf>,
    passphrase: Passphrase,
    agent: Option<String>,
    interactive_auth: InteractiveAuth,
    connect_timeout: Duration,
}

impl From<&Hop> for Stage {
    fn from(h: &Hop) -> Self {
        Stage {
            host: h.host.clone(),
            port: h.port,
            username: h.username.clone(),
            password: h.password.clone(),
            private_key_path: h.private_key_path.clone(),
            passphrase: h.passphrase.clone(),
            agent: h.agent.clone(),
            interactive_auth: h.interactive_auth.clone(),
            connect_timeout: h.connect_timeout,
        }
    }
}

fn preferred(alg: &Algorithms) -> Preferred {
    let mut p = Preferred::default();
    if let Some(list) = &alg.kex {
        let names: Vec<_> = list
            .iter()
            .filter_map(|n| russh::kex::Name::try_from(n.as_str()).ok())
            .collect();
        if !names.is_empty() {
            p.kex = names.into();
        }
    }
    if let Some(list) = &alg.cipher {
        let names: Vec<_> = list
            .iter()
            .filter_map(|n| {
                let n = match n.as_str() {
                    "aes128-gcm" => "aes128-gcm@openssh.com",
                    "aes256-gcm" => "aes256-gcm@openssh.com",
                    other => other,
                };
                russh::cipher::Name::try_from(n).ok()
            })
            .collect();
        if !names.is_empty() {
            p.cipher = names.into();
        }
    }
    if let Some(list) = &alg.hmac {
        let names: Vec<_> = list
            .iter()
            .filter_map(|n| russh::mac::Name::try_from(n.as_str()).ok())
            .collect();
        if !names.is_empty() {
            p.mac = names.into();
        }
    }
    if let Some(list) = &alg.server_host_key {
        let names: Vec<_> = list
            .iter()
            .filter_map(|n| n.parse::<keys::Algorithm>().ok())
            .collect();
        if !names.is_empty() {
            p.key = names.into();
        }
    }
    p
}

fn default_identity_files() -> Vec<PathBuf> {
    let Some(home) = crate::dirs_home() else {
        return vec![];
    };
    let ssh = PathBuf::from(home).join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|n| ssh.join(n))
        .filter(|p| p.exists())
        .collect()
}

impl SftpRemote {
    async fn connect(ctx: &Arc<Ctx>, cfg: &Resolved) -> Result<SftpRemote, String> {
        let mut stages = vec![Stage {
            host: cfg.host.clone(),
            port: cfg.port,
            username: cfg.username.clone(),
            password: cfg.password.clone(),
            private_key_path: cfg.private_key_path.clone(),
            passphrase: cfg.passphrase.clone(),
            agent: cfg.agent.clone(),
            interactive_auth: cfg.interactive_auth.clone(),
            connect_timeout: cfg.connect_timeout,
        }];
        stages.extend(cfg.hops.iter().map(Stage::from));

        let config = Arc::new(client::Config {
            preferred: preferred(&cfg.algorithms),
            keepalive_interval: Some(Duration::from_secs(30)),
            nodelay: true,
            ..Default::default()
        });

        let mut handles: Vec<Handle<SshHandler>> = Vec::new();
        for (i, stage) in stages.iter().enumerate() {
            if i > 0 {
                ctx.info(format!(
                    "Hopping to {}@{}:{}",
                    stage.username, stage.host, stage.port
                ));
            } else {
                ctx.info(format!(
                    "Connecting to {}@{}:{}",
                    stage.username, stage.host, stage.port
                ));
            }
            let rejection = Arc::new(StdMutex::new(None));
            let handler = SshHandler {
                ctx: ctx.clone(),
                host: stage.host.clone(),
                port: stage.port,
                rejection: rejection.clone(),
            };
            let connecting = async {
                match handles.last() {
                    None => {
                        client::connect(config.clone(), (stage.host.as_str(), stage.port), handler)
                            .await
                    }
                    Some(prev) => {
                        let channel = prev
                            .channel_open_direct_tcpip(
                                stage.host.clone(),
                                stage.port as u32,
                                "127.0.0.1",
                                0,
                            )
                            .await?;
                        client::connect_stream(config.clone(), channel.into_stream(), handler).await
                    }
                }
            };
            // Host-key prompts can wait on the user; only time the network part.
            let handle = match tokio::time::timeout(
                stage.connect_timeout + PROMPT_GRACE,
                connecting,
            )
            .await
            {
                Ok(Ok(h)) => h,
                Ok(Err(e)) => {
                    let reason = rejection.lock().unwrap().take();
                    return Err(
                        reason.unwrap_or_else(|| format!("{}:{}: {e}", stage.host, stage.port))
                    );
                }
                Err(_) => {
                    return Err(format!(
                        "{}:{}: connection timed out",
                        stage.host, stage.port
                    ))
                }
            };
            let mut handle = handle;
            let prev = handles.last();
            authenticate(ctx, &mut handle, stage, prev).await?;
            handles.push(handle);
        }

        let last = handles.last().expect("at least one stage");
        let channel = last
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("SFTP subsystem: {e}"))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("SFTP: {e}"))?;
        sftp.set_timeout(cfg.connect_timeout.as_secs().max(30));
        ctx.info(format!("Connected to {}", cfg.host));
        Ok(SftpRemote { sftp, handles })
    }
}

const PROMPT_GRACE: Duration = Duration::from_secs(300);

/// Read a key that lives on the previous hop (the extension's hop semantics).
async fn read_on_hop(prev: &Handle<SshHandler>, path: &Path) -> Result<String, String> {
    let mut channel = prev
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    channel
        .exec(true, format!("cat {quoted}"))
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => {
                return Err(format!("cat {} exited with {exit_status}", path.display()))
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

async fn load_key(
    ctx: &Arc<Ctx>,
    stage: &Stage,
    path: &Path,
    prev: Option<&Handle<SshHandler>>,
) -> Result<keys::PrivateKey, String> {
    let text = match prev {
        Some(prev) if !path.exists() => read_on_hop(prev, path).await?,
        _ => std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?,
    };
    let given = match &stage.passphrase {
        Passphrase::Value(v) => Some(v.clone()),
        _ => None,
    };
    match keys::decode_secret_key(&text, given.as_deref()) {
        Ok(k) => Ok(k),
        Err(keys::Error::KeyIsEncrypted) => {
            let cache = format!("passphrase:{}", path.display());
            for _ in 0..3 {
                let Some(pass) = ctx
                    .secret(
                        &cache,
                        "Key passphrase",
                        &format!("Passphrase for {}", path.display()),
                    )
                    .await
                else {
                    return Err("Passphrase entry cancelled".into());
                };
                match keys::decode_secret_key(&text, Some(&pass)) {
                    Ok(k) => return Ok(k),
                    Err(_) => ctx.forget(&cache),
                }
            }
            Err(format!("Wrong passphrase for {}", path.display()))
        }
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

async fn authenticate(
    ctx: &Arc<Ctx>,
    handle: &mut Handle<SshHandler>,
    stage: &Stage,
    prev: Option<&Handle<SshHandler>>,
) -> Result<(), String> {
    let user = stage.username.clone();
    let target = format!("{}@{}:{}", stage.username, stage.host, stage.port);
    let err = |e: russh::Error| format!("{target}: {e}");

    if let Some(password) = &stage.password {
        if handle
            .authenticate_password(&user, password)
            .await
            .map_err(err)?
            .success()
        {
            return Ok(());
        }
    }

    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();

    let explicit_key = stage.private_key_path.is_some();
    let key_files = match &stage.private_key_path {
        Some(p) => vec![p.clone()],
        None => default_identity_files(),
    };
    for path in key_files {
        let key = if explicit_key {
            load_key(ctx, stage, &path, prev).await?
        } else {
            // Implicit default keys: skip encrypted ones rather than prompting.
            match std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| keys::decode_secret_key(&t, None).ok())
            {
                Some(k) => k,
                None => continue,
            }
        };
        let auth = handle
            .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash))
            .await
            .map_err(err)?;
        if auth.success() {
            return Ok(());
        }
    }

    if let Some(agent) = agent_client(stage).await {
        let mut agent = agent;
        if let Ok(identities) = agent.request_identities().await {
            for identity in identities {
                let key = identity.public_key().into_owned();
                let hash = if key.algorithm().is_rsa() {
                    rsa_hash
                } else {
                    None
                };
                match handle
                    .authenticate_publickey_with(&user, key, hash, &mut agent)
                    .await
                {
                    Ok(r) if r.success() => return Ok(()),
                    _ => {}
                }
            }
        }
    }

    // keyboard-interactive: 2FA codes, or servers that only ask for passwords this way.
    if (stage.interactive_auth != InteractiveAuth::Off || stage.password.is_some())
        && keyboard_interactive(ctx, handle, stage).await?
    {
        return Ok(());
    }

    // Nothing configured worked: ask for a password, as the extension does.
    let cache = format!("password:{target}");
    for attempt in 0..3 {
        let Some(password) = ctx
            .secret(&cache, "SSH password", &format!("Password for {target}"))
            .await
        else {
            return Err(format!("{target}: authentication cancelled"));
        };
        if handle
            .authenticate_password(&user, &password)
            .await
            .map_err(err)?
            .success()
        {
            return Ok(());
        }
        let staged = Stage {
            password: Some(password),
            interactive_auth: InteractiveAuth::Off,
            ..stage_clone(stage)
        };
        if keyboard_interactive(ctx, handle, &staged).await? {
            return Ok(());
        }
        ctx.forget(&cache);
        if attempt < 2 {
            ctx.error(format!("{target}: wrong password"));
        }
    }
    Err(format!("{target}: authentication failed"))
}

fn stage_clone(s: &Stage) -> Stage {
    Stage {
        host: s.host.clone(),
        port: s.port,
        username: s.username.clone(),
        password: s.password.clone(),
        private_key_path: s.private_key_path.clone(),
        passphrase: s.passphrase.clone(),
        agent: s.agent.clone(),
        interactive_auth: s.interactive_auth.clone(),
        connect_timeout: s.connect_timeout,
    }
}

#[cfg(unix)]
async fn agent_client(
    stage: &Stage,
) -> Option<keys::agent::client::AgentClient<tokio::net::UnixStream>> {
    match &stage.agent {
        Some(path) if path != "pageant" => keys::agent::client::AgentClient::connect_uds(path)
            .await
            .ok(),
        _ => keys::agent::client::AgentClient::connect_env().await.ok(),
    }
}

#[cfg(not(unix))]
async fn agent_client(
    _stage: &Stage,
) -> Option<keys::agent::client::AgentClient<tokio::net::TcpStream>> {
    None
}

async fn keyboard_interactive(
    ctx: &Arc<Ctx>,
    handle: &mut Handle<SshHandler>,
    stage: &Stage,
) -> Result<bool, String> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let target = format!("{}@{}", stage.username, stage.host);
    let mut reply = handle
        .authenticate_keyboard_interactive_start(stage.username.clone(), None)
        .await
        .map_err(|e| e.to_string())?;
    let mut answers = match &stage.interactive_auth {
        InteractiveAuth::Answers(a) => a.clone().into_iter(),
        _ => Vec::new().into_iter(),
    };
    let mut password_used = false;
    for _ in 0..8 {
        match reply {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let mut responses = Vec::with_capacity(prompts.len());
                for p in &prompts {
                    let is_password = p.prompt.to_lowercase().contains("password");
                    let answer = if is_password && !password_used && stage.password.is_some() {
                        password_used = true;
                        stage.password.clone()
                    } else if let Some(a) = answers.next() {
                        Some(a)
                    } else if stage.interactive_auth == InteractiveAuth::Prompt
                        || (is_password && stage.password.is_none())
                    {
                        let title = if name.is_empty() {
                            "Verification".to_string()
                        } else {
                            name.clone()
                        };
                        let message = if instructions.is_empty() {
                            format!("{target}: {}", p.prompt)
                        } else {
                            format!("{target}: {instructions}\n{}", p.prompt)
                        };
                        ctx.ask(&title, &message, !p.echo).await
                    } else {
                        None
                    };
                    match answer {
                        Some(a) => responses.push(a),
                        None => return Ok(false),
                    }
                }
                reply = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------- FTP / FTPS

impl FtpRemote {
    async fn connect(ctx: &Arc<Ctx>, cfg: &Resolved) -> Result<FtpRemote, String> {
        ctx.info(format!(
            "Connecting to ftp://{}@{}:{}",
            cfg.username, cfg.host, cfg.port
        ));
        let addr = (cfg.host.as_str(), cfg.port);
        let tls = || -> Result<AsyncNativeTlsConnector, String> {
            let connector = suppaftp::async_native_tls::TlsConnector::new()
                .danger_accept_invalid_certs(!cfg.reject_unauthorized)
                .danger_accept_invalid_hostnames(!cfg.reject_unauthorized);
            Ok(AsyncNativeTlsConnector::from(connector))
        };
        let connecting = async {
            let stream = match cfg.secure {
                FtpSecure::Implicit => {
                    AsyncNativeTlsFtpStream::connect_secure_implicit(addr, tls()?, &cfg.host)
                        .await
                        .map_err(|e| e.to_string())?
                }
                FtpSecure::Explicit => AsyncNativeTlsFtpStream::connect(addr)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_secure(tls()?, &cfg.host)
                    .await
                    .map_err(|e| e.to_string())?,
                FtpSecure::None => AsyncNativeTlsFtpStream::connect(addr)
                    .await
                    .map_err(|e| e.to_string())?,
            };
            Ok::<_, String>(stream)
        };
        let mut stream = tokio::time::timeout(cfg.connect_timeout, connecting)
            .await
            .map_err(|_| format!("{}:{}: connection timed out", cfg.host, cfg.port))??;
        if !cfg.passive {
            stream = stream.active_mode(Duration::from_secs(30));
        }
        let target = format!("{}@{}:{}", cfg.username, cfg.host, cfg.port);
        let cache = format!("ftp-password:{target}");
        let mut password = cfg.password.clone();
        let mut logged_in = false;
        for _ in 0..3 {
            let pass = match &password {
                Some(p) => p.clone(),
                None if cfg.username == "anonymous" => String::new(),
                None => match ctx
                    .secret(&cache, "FTP password", &format!("Password for {target}"))
                    .await
                {
                    Some(p) => p,
                    None => return Err(format!("{target}: authentication cancelled")),
                },
            };
            match stream.login(cfg.username.as_str(), pass.as_str()).await {
                Ok(()) => {
                    logged_in = true;
                    break;
                }
                Err(e) => {
                    ctx.forget(&cache);
                    if password.is_some() || cfg.username == "anonymous" {
                        return Err(format!("{target}: {e}"));
                    }
                    ctx.error(format!("{target}: {e}"));
                    password = None;
                }
            }
        }
        if !logged_in {
            return Err(format!("{target}: authentication failed"));
        }
        stream
            .transfer_type(suppaftp::types::FileType::Binary)
            .await
            .map_err(|e| e.to_string())?;
        ctx.info(format!("Connected to {}", cfg.host));
        Ok(FtpRemote {
            stream: Mutex::new(stream),
        })
    }

    async fn list(&self, dir: &str) -> Result<Vec<Entry>, String> {
        let mut ftp = self.stream.lock().await;
        let (lines, mlsd) = match ftp.mlsd(Some(dir)).await {
            Ok(lines) => (lines, true),
            Err(_) => (
                ftp.list(Some(dir))
                    .await
                    .map_err(|e| format!("{dir}: {e}"))?,
                false,
            ),
        };
        let mut out = Vec::new();
        for line in lines {
            let parsed = if mlsd {
                suppaftp::list::ListParser::parse_mlsd(&line)
            } else {
                suppaftp::list::ListParser::parse_posix(&line)
                    .or_else(|_| suppaftp::list::ListParser::parse_dos(&line))
            };
            let Ok(file) = parsed else { continue };
            let name = file.name().to_string();
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }
            out.push(Entry {
                path: config::join_remote(dir, &name),
                name,
                kind: if file.is_directory() {
                    Kind::Dir
                } else if file.is_symlink() {
                    Kind::Symlink
                } else {
                    Kind::File
                },
                size: file.size() as u64,
                mtime: file
                    .modified()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn stat(&self, path: &str) -> Result<Option<Entry>, String> {
        let Some(parent) = config::remote_parent(path) else {
            return Ok(Some(Entry {
                name: "/".into(),
                path: "/".into(),
                kind: Kind::Dir,
                size: 0,
                mtime: 0,
            }));
        };
        let name = config::remote_name(path);
        match self.list(&parent).await {
            Ok(entries) => Ok(entries.into_iter().find(|e| e.name == name)),
            Err(_) => Ok(None),
        }
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let mut ftp = self.stream.lock().await;
        let mut stream = ftp
            .retr_as_stream(path)
            .await
            .map_err(|e| format!("{path}: {e}"))?;
        let mut buf = Vec::new();
        stream
            .read_to_end(&mut buf)
            .await
            .map_err(|e| format!("{path}: {e}"))?;
        stream.finish().await.map_err(|e| format!("{path}: {e}"))?;
        Ok(buf)
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let mut ftp = self.stream.lock().await;
        let mut reader = data;
        ftp.put_file(path, &mut reader)
            .await
            .map_err(|e| format!("{path}: {e}"))?;
        Ok(())
    }
}
