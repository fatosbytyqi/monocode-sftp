//! `.vscode/sftp.json` / `.monocode/sftp.json` loading. The format matches the VS Code SFTP extension
//! (Natizyskunk.sftp) so existing project configs work unchanged: one object or
//! an array of objects, each with optional `profiles`, `defaultProfile`, `hop`,
//! `context`, `watcher` and a `remote` reference to a user-level definition.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::fs::expand_home;

pub const CONFIG_RELATIVE: &str = ".vscode/sftp.json";
/// Where a config made from scratch in MonoCode lives.
pub const MONOCODE_CONFIG_RELATIVE: &str = ".monocode/sftp.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Sftp,
    Ftp,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Passphrase {
    None,
    Value(String),
    Prompt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InteractiveAuth {
    Off,
    Prompt,
    Answers(Vec<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FtpSecure {
    None,
    /// `true` or `"control"`: explicit FTPS (AUTH TLS).
    Explicit,
    Implicit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadOnOpen {
    Off,
    On,
    Confirm,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Algorithms {
    pub kex: Option<Vec<String>>,
    pub cipher: Option<Vec<String>>,
    pub server_host_key: Option<Vec<String>>,
    pub hmac: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<PathBuf>,
    pub passphrase: Passphrase,
    pub agent: Option<String>,
    pub interactive_auth: InteractiveAuth,
    pub connect_timeout: Duration,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncOption {
    pub delete: bool,
    pub skip_create: bool,
    pub ignore_existing: bool,
    pub update: bool,
}

impl Default for SyncOption {
    /// Without a `syncOption` block the extension mirrors new and changed files
    /// and leaves extra destination files alone.
    fn default() -> Self {
        Self {
            delete: false,
            skip_create: false,
            ignore_existing: false,
            update: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatcherConfig {
    /// One glob (the extension's format) or several; a file matching any is watched.
    pub files: Vec<String>,
    pub auto_upload: bool,
    pub auto_delete: bool,
}

/// A config entry after profile, `remote` and default merging.
#[derive(Clone, Debug)]
pub struct Resolved {
    /// Stable id: `<index in sftp.json>`.
    pub index: usize,
    pub name: String,
    pub context: PathBuf,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub connect_timeout: Duration,
    pub agent: Option<String>,
    pub private_key_path: Option<PathBuf>,
    pub passphrase: Passphrase,
    pub interactive_auth: InteractiveAuth,
    pub algorithms: Algorithms,
    pub hops: Vec<Hop>,
    pub ssh_custom_params: String,
    pub secure: FtpSecure,
    pub reject_unauthorized: bool,
    pub passive: bool,
    pub remote_path: String,
    pub upload_on_save: bool,
    pub use_temp_file: bool,
    pub open_ssh: bool,
    pub download_on_open: DownloadOnOpen,
    pub ignore: Gitignore,
    pub watcher: Option<WatcherConfig>,
    pub concurrency: usize,
    pub sync_option: SyncOption,
    pub remote_time_offset_secs: i64,
    pub files_exclude: Vec<String>,
    pub order: i64,
    pub profiles: Vec<String>,
    pub active_profile: Option<String>,
}

impl Resolved {
    /// Connections are shared by every config pointing at the same server.
    pub fn connection_key(&self) -> String {
        let hops: Vec<String> = self
            .hops
            .iter()
            .map(|h| format!("{}@{}:{}", h.username, h.host, h.port))
            .collect();
        format!(
            "{:?}|{}@{}:{}|{}|{:?}",
            self.protocol,
            self.username,
            self.host,
            self.port,
            hops.join(">"),
            self.secure
        )
    }

    pub fn contains(&self, local: &Path) -> bool {
        local.starts_with(&self.context)
    }

    /// Local path -> remote path. `None` when outside this config's context.
    pub fn to_remote(&self, local: &Path) -> Option<String> {
        let rel = local.strip_prefix(&self.context).ok()?;
        Some(join_remote(&self.remote_path, &rel_to_slash(rel)))
    }

    /// Remote path -> local path. `None` when outside `remotePath`.
    pub fn to_local(&self, remote: &str) -> Option<PathBuf> {
        let base = self.remote_path.trim_end_matches('/');
        let rest = if remote == base || (base.is_empty() && remote == "/") {
            ""
        } else if base.is_empty() {
            remote.strip_prefix('/')?
        } else {
            remote.strip_prefix(base)?.strip_prefix('/')?
        };
        let mut out = self.context.clone();
        for part in rest.split('/').filter(|p| !p.is_empty()) {
            if part == ".." || part == "." {
                return None;
            }
            out.push(part);
        }
        Some(out)
    }

    /// gitignore semantics relative to the context folder.
    pub fn is_ignored(&self, local: &Path, is_dir: bool) -> bool {
        let Ok(rel) = local.strip_prefix(&self.context) else {
            return true;
        };
        if rel.as_os_str().is_empty() {
            return false;
        }
        self.ignore
            .matched_path_or_any_parents(rel, is_dir)
            .is_ignore()
    }

    pub fn is_ignored_remote(&self, remote: &str, is_dir: bool) -> bool {
        match self.to_local(remote) {
            Some(local) => self.is_ignored(&local, is_dir),
            None => false,
        }
    }
}

pub fn rel_to_slash(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn join_remote(base: &str, rel: &str) -> String {
    if rel.is_empty() {
        return if base.is_empty() {
            "/".into()
        } else {
            base.to_string()
        };
    }
    let base = base.trim_end_matches('/');
    format!("{base}/{}", rel.trim_start_matches('/'))
}

pub fn remote_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let idx = trimmed.rfind('/')?;
    Some(if idx == 0 {
        "/".into()
    } else {
        trimmed[..idx].to_string()
    })
}

pub fn remote_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// The project's config: an existing `.vscode/sftp.json` (shared with the VS
/// Code extension) wins; otherwise `.monocode/sftp.json`, which is also where a
/// new config is created.
pub fn config_path(workspace: &Path) -> PathBuf {
    let vscode = workspace.join(CONFIG_RELATIVE);
    if vscode.is_file() {
        vscode
    } else {
        workspace.join(MONOCODE_CONFIG_RELATIVE)
    }
}

pub fn is_config_file(workspace: &Path, path: &Path) -> bool {
    path == workspace.join(CONFIG_RELATIVE) || path == workspace.join(MONOCODE_CONFIG_RELATIVE)
}

/// User-level named remotes (the extension's `remotefs.remote` setting).
pub fn user_remotes_path() -> Option<PathBuf> {
    crate::dirs_home().map(|home| {
        PathBuf::from(home)
            .join(".monocode")
            .join("sftp-remotes.json")
    })
}

fn load_user_remotes() -> Map<String, Value> {
    let Some(path) = user_remotes_path() else {
        return Map::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_jsonc(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// sftp.json allows comments and trailing commas, as VS Code does.
pub fn parse_jsonc(text: &str) -> Result<Value, String> {
    let mut out = String::with_capacity(text.len());
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut in_str = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
        } else if c == '/' && bytes.get(i + 1) == Some(&'/') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && bytes.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == ',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_whitespace() {
                j += 1;
            }
            if !matches!(bytes.get(j), Some('}') | Some(']')) {
                out.push(c);
            }
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    serde_json::from_str(&out).map_err(|e| format!("sftp.json: {e}"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSummary {
    pub index: usize,
    pub name: String,
    pub context: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_path: String,
    pub upload_on_save: bool,
    pub download_on_open: DownloadOnOpen,
    pub watcher: Option<WatcherConfig>,
    pub profiles: Vec<String>,
    pub active_profile: Option<String>,
    pub files_exclude: Vec<String>,
    pub order: i64,
    pub hops: usize,
}

impl From<&Resolved> for ConfigSummary {
    fn from(c: &Resolved) -> Self {
        Self {
            index: c.index,
            name: c.name.clone(),
            context: c.context.to_string_lossy().into_owned(),
            protocol: c.protocol,
            host: c.host.clone(),
            port: c.port,
            username: c.username.clone(),
            remote_path: c.remote_path.clone(),
            upload_on_save: c.upload_on_save,
            download_on_open: c.download_on_open,
            watcher: c.watcher.clone(),
            profiles: c.profiles.clone(),
            active_profile: c.active_profile.clone(),
            files_exclude: c.files_exclude.clone(),
            order: c.order,
            hops: c.hops.len(),
        }
    }
}

/// Raw entries, before profile merging. Used to list profiles and defaults.
pub fn read_raw(workspace: &Path) -> Result<Option<Vec<Map<String, Value>>>, String> {
    let path = config_path(workspace);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let value = parse_jsonc(&text)?;
    let entries = match value {
        Value::Array(items) => items,
        other => vec![other],
    };
    let mut out = Vec::with_capacity(entries.len());
    for (i, entry) in entries.into_iter().enumerate() {
        match entry {
            Value::Object(map) => out.push(map),
            _ => return Err(format!("sftp.json: entry {i} is not an object")),
        }
    }
    Ok(Some(out))
}

/// `active_profiles` maps config index -> chosen profile (overrides defaultProfile).
pub fn load(
    workspace: &Path,
    active_profiles: &HashMap<usize, Option<String>>,
) -> Result<Vec<Resolved>, String> {
    let Some(raw) = read_raw(workspace)? else {
        return Ok(vec![]);
    };
    let remotes = if raw.iter().any(|m| m.contains_key("remote")) {
        load_user_remotes()
    } else {
        Map::new()
    };
    let multiple = raw.len() > 1;
    let mut out = Vec::with_capacity(raw.len());
    for (index, entry) in raw.into_iter().enumerate() {
        let chosen = active_profiles.get(&index).cloned();
        let resolved = resolve_entry(workspace, index, &entry, chosen, &remotes)?;
        if multiple && resolved.name.is_empty() {
            return Err(format!(
                "sftp.json: entry {index} needs a \"name\" when there are multiple configs"
            ));
        }
        out.push(resolved);
    }
    if multiple {
        let mut contexts: Vec<&PathBuf> = out.iter().map(|c| &c.context).collect();
        contexts.sort();
        contexts.dedup();
        if contexts.len() != out.len() {
            return Err("sftp.json: each config needs a different \"context\"".into());
        }
    }
    Ok(out)
}

/// Resolve one raw entry. `chosen`: `None` = use `defaultProfile`,
/// `Some(None)` = no profile, `Some(Some(p))` = profile `p`.
pub fn resolve_entry(
    workspace: &Path,
    index: usize,
    entry: &Map<String, Value>,
    chosen: Option<Option<String>>,
    remotes: &Map<String, Value>,
) -> Result<Resolved, String> {
    let profiles: Vec<String> = entry
        .get("profiles")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    let default_profile = entry
        .get("defaultProfile")
        .and_then(Value::as_str)
        .map(str::to_string);
    let active = chosen
        .unwrap_or(default_profile)
        .filter(|p| profiles.contains(p));

    let mut merged = Map::new();
    if let Some(remote) = entry.get("remote").and_then(Value::as_str) {
        match remotes.get(remote).and_then(Value::as_object) {
            Some(base) => merged.extend(base.clone()),
            None => {
                return Err(format!(
                    "sftp.json: remote \"{remote}\" is not defined in ~/.monocode/sftp-remotes.json"
                ))
            }
        }
    }
    merged.extend(entry.clone());
    if let Some(profile) = &active {
        if let Some(Value::Object(overrides)) = entry.get("profiles").and_then(|p| p.get(profile)) {
            for (k, v) in overrides {
                merged.insert(k.clone(), v.clone());
            }
        }
    }
    resolve(workspace, index, merged, profiles, active)
}

/// A single unsaved entry (from the setup form), with user remotes available.
pub fn resolve_unsaved(
    workspace: &Path,
    entry: &Map<String, Value>,
    profile: Option<String>,
) -> Result<Resolved, String> {
    let remotes = if entry.contains_key("remote") {
        load_user_remotes()
    } else {
        Map::new()
    };
    resolve_entry(workspace, 0, entry, Some(profile), &remotes)
}

fn str_of(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn bool_of(map: &Map<String, Value>, key: &str, default: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn expand_path(workspace: &Path, raw: &str) -> PathBuf {
    let substituted = raw
        .replace("${workspaceFolder}", &workspace.to_string_lossy())
        .replace("${workspaceRoot}", &workspace.to_string_lossy());
    let expanded = expand_home(&substituted);
    let path = expanded;
    if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    }
}

fn passphrase_of(map: &Map<String, Value>) -> Passphrase {
    match map.get("passphrase") {
        Some(Value::Bool(true)) => Passphrase::Prompt,
        Some(Value::String(s)) if !s.is_empty() => Passphrase::Value(s.clone()),
        _ => Passphrase::None,
    }
}

fn interactive_of(map: &Map<String, Value>) -> InteractiveAuth {
    match map.get("interactiveAuth") {
        Some(Value::Bool(true)) => InteractiveAuth::Prompt,
        Some(Value::Array(items)) => InteractiveAuth::Answers(
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        ),
        _ => InteractiveAuth::Off,
    }
}

fn timeout_of(map: &Map<String, Value>) -> Duration {
    Duration::from_millis(
        map.get("connectTimeout")
            .and_then(Value::as_u64)
            .unwrap_or(10_000),
    )
}

fn resolve_hops(workspace: &Path, value: Option<&Value>) -> Result<Vec<Hop>, String> {
    let items: Vec<&Value> = match value {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(items)) => items.iter().collect(),
        Some(v @ Value::Object(_)) => vec![v],
        Some(_) => return Err("sftp.json: \"hop\" must be an object or an array".into()),
    };
    items
        .into_iter()
        .map(|item| {
            let map = item
                .as_object()
                .ok_or("sftp.json: each hop must be an object")?;
            Ok(Hop {
                host: str_of(map, "host").ok_or("sftp.json: hop is missing \"host\"")?,
                port: map.get("port").and_then(Value::as_u64).unwrap_or(22) as u16,
                username: str_of(map, "username")
                    .ok_or("sftp.json: hop is missing \"username\"")?,
                password: str_of(map, "password"),
                private_key_path: str_of(map, "privateKeyPath").map(|p| expand_path(workspace, &p)),
                passphrase: passphrase_of(map),
                agent: str_of(map, "agent"),
                interactive_auth: interactive_of(map),
                connect_timeout: timeout_of(map),
            })
        })
        .collect()
}

/// Apply `Host` blocks from an OpenSSH config (`sshConfigPath`).
fn apply_ssh_config(
    path: &Path,
    host: &mut String,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    key: &mut Option<PathBuf>,
) {
    use ssh2_config::{ParseRule, SshConfig};
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(config) = SshConfig::default().parse(&mut reader, ParseRule::ALLOW_UNKNOWN_FIELDS)
    else {
        return;
    };
    let params = config.query(host.as_str());
    if let Some(name) = params.host_name {
        *host = name;
    }
    if port.is_none() {
        *port = params.port;
    }
    if username.is_none() {
        *username = params.user;
    }
    if key.is_none() {
        if let Some(first) = params
            .identity_file
            .and_then(|files| files.into_iter().next())
        {
            *key = Some(expand_home(&first.to_string_lossy()));
        }
    }
}

fn build_ignore(context: &Path, workspace: &Path, map: &Map<String, Value>) -> Gitignore {
    let mut builder = GitignoreBuilder::new(context);
    let patterns: Vec<String> = match map.get("ignore") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => vec![],
    };
    for pattern in &patterns {
        let _ = builder.add_line(None, pattern);
    }
    if let Some(file) = str_of(map, "ignoreFile") {
        let path = expand_path(workspace, &file);
        // A missing ignore file (the default `.gitignore`) is fine.
        let _ = builder.add(&path);
    }
    // The config file itself never leaves the machine.
    let _ = builder.add_line(None, "/.vscode/sftp.json");
    let _ = builder.add_line(None, "/.monocode/");
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn resolve(
    workspace: &Path,
    index: usize,
    map: Map<String, Value>,
    profiles: Vec<String>,
    active_profile: Option<String>,
) -> Result<Resolved, String> {
    let protocol = match map
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("sftp")
    {
        "sftp" => Protocol::Sftp,
        "ftp" => Protocol::Ftp,
        "local" => Protocol::Local,
        other => return Err(format!("sftp.json: unknown protocol \"{other}\"")),
    };
    let context = match str_of(&map, "context") {
        Some(rel) => {
            let p = expand_path(workspace, &rel);
            normalize(&p)
        }
        None => workspace.to_path_buf(),
    };
    let mut host = str_of(&map, "host").unwrap_or_default();
    let mut port = map.get("port").and_then(Value::as_u64).map(|p| p as u16);
    let mut username = str_of(&map, "username");
    let mut private_key_path = str_of(&map, "privateKeyPath").map(|p| expand_path(workspace, &p));
    if protocol == Protocol::Sftp {
        let ssh_config = str_of(&map, "sshConfigPath")
            .map(|p| expand_path(workspace, &p))
            .or_else(|| crate::dirs_home().map(|h| PathBuf::from(h).join(".ssh").join("config")));
        if let Some(path) = ssh_config {
            if !host.is_empty() {
                apply_ssh_config(
                    &path,
                    &mut host,
                    &mut port,
                    &mut username,
                    &mut private_key_path,
                );
            }
        }
    }
    if protocol != Protocol::Local && host.is_empty() {
        return Err(format!("sftp.json: entry {index} is missing \"host\""));
    }
    let username = match (protocol, username) {
        (Protocol::Local, u) => u.unwrap_or_default(),
        (Protocol::Ftp, None) => "anonymous".into(),
        (_, Some(u)) => u,
        (_, None) => std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .map_err(|_| format!("sftp.json: entry {index} is missing \"username\""))?,
    };
    let port = port.unwrap_or(match protocol {
        Protocol::Ftp => 21,
        _ => 22,
    });
    let remote_path = match str_of(&map, "remotePath") {
        Some(p) => p,
        None => "/".into(),
    };
    let remote_path = if remote_path.len() > 1 {
        remote_path.trim_end_matches('/').to_string()
    } else {
        remote_path
    };

    let secure = match map.get("secure") {
        Some(Value::Bool(true)) => FtpSecure::Explicit,
        Some(Value::String(s)) if s == "control" => FtpSecure::Explicit,
        Some(Value::String(s)) if s == "implicit" => FtpSecure::Implicit,
        _ => FtpSecure::None,
    };
    let reject_unauthorized = map
        .get("secureOptions")
        .and_then(|o| o.get("rejectUnauthorized"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let download_on_open = match map.get("downloadOnOpen") {
        Some(Value::Bool(true)) => DownloadOnOpen::On,
        Some(Value::String(s)) if s == "confirm" => DownloadOnOpen::Confirm,
        _ => DownloadOnOpen::Off,
    };

    let watcher = map.get("watcher").and_then(Value::as_object).and_then(|w| {
        let files: Vec<String> = match w.get("files")? {
            Value::String(s) => vec![s.clone()],
            Value::Array(items) => items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
            _ => vec![],
        };
        let files: Vec<String> = files.into_iter().filter(|f| !f.trim().is_empty()).collect();
        if files.is_empty() {
            return None;
        }
        Some(WatcherConfig {
            files,
            auto_upload: w.get("autoUpload").and_then(Value::as_bool).unwrap_or(true),
            auto_delete: w
                .get("autoDelete")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    });

    let sync_option = match map.get("syncOption").and_then(Value::as_object) {
        Some(o) => SyncOption {
            delete: bool_of(o, "delete", false),
            skip_create: bool_of(o, "skipCreate", false),
            ignore_existing: bool_of(o, "ignoreExisting", false),
            update: bool_of(o, "update", false),
        },
        None => SyncOption::default(),
    };

    let mut concurrency = map
        .get("concurrency")
        .and_then(Value::as_u64)
        .unwrap_or(4)
        .max(1) as usize;
    match map.get("limitOpenFilesOnRemote") {
        Some(Value::Bool(true)) => concurrency = concurrency.min(222),
        Some(Value::Number(n)) => concurrency = concurrency.min(n.as_u64().unwrap_or(222) as usize),
        _ => {}
    }
    if protocol == Protocol::Ftp {
        // One control connection; FTP cannot multiplex transfers on it.
        concurrency = 1;
    }

    let remote_explorer = map.get("remoteExplorer").and_then(Value::as_object);
    let files_exclude = remote_explorer
        .and_then(|r| r.get("filesExclude"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let order = remote_explorer
        .and_then(|r| r.get("order"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let algorithms = map
        .get("algorithms")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let name = str_of(&map, "name").unwrap_or_else(|| {
        if host.is_empty() {
            "local".into()
        } else {
            host.clone()
        }
    });
    let ignore = build_ignore(&context, workspace, &map);

    Ok(Resolved {
        index,
        name,
        context,
        protocol,
        host,
        port,
        username,
        password: map
            .get("password")
            .and_then(Value::as_str)
            .map(str::to_string),
        connect_timeout: timeout_of(&map),
        agent: str_of(&map, "agent"),
        private_key_path,
        passphrase: passphrase_of(&map),
        interactive_auth: interactive_of(&map),
        algorithms,
        hops: resolve_hops(workspace, map.get("hop"))?,
        ssh_custom_params: str_of(&map, "sshCustomParams")
            .unwrap_or_else(|| "\"cd \\\"${remotePath}\\\"; exec \\$SHELL -l\"".into()),
        secure,
        reject_unauthorized,
        passive: bool_of(&map, "passive", true),
        remote_path,
        upload_on_save: bool_of(&map, "uploadOnSave", false),
        use_temp_file: bool_of(&map, "useTempFile", false),
        open_ssh: bool_of(&map, "openSsh", false),
        download_on_open,
        ignore,
        watcher,
        concurrency,
        sync_option,
        remote_time_offset_secs: (map
            .get("remoteTimeOffsetInHours")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            * 3600.0) as i64,
        files_exclude,
        order,
        profiles,
        active_profile,
    })
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub const TEMPLATE: &str = r#"{
  "name": "My Server",
  "host": "example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "username",
  "remotePath": "/var/www/html",
  "uploadOnSave": true,
  "useTempFile": false,
  "openSsh": false,
  "downloadOnOpen": false,
  "ignore": [".vscode", ".git", ".DS_Store", "node_modules"],
  "watcher": {
    "files": "**/*",
    "autoUpload": false,
    "autoDelete": false
  },
  "syncOption": {
    "delete": false,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": true
  },
  "profiles": {
    "dev": {
      "host": "dev.example.com",
      "remotePath": "/home/user/app"
    },
    "prod": {
      "host": "prod.example.com",
      "remotePath": "/var/www/app",
      "uploadOnSave": false
    }
  },
  "defaultProfile": "dev"
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir.join(".vscode")).unwrap();
        std::fs::write(dir.join(CONFIG_RELATIVE), text).unwrap();
    }

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sftp-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn jsonc_comments_and_trailing_commas() {
        let v = parse_jsonc("{\n // c\n \"a\": \"//x\", /* b */ \"b\": [1,2,],\n}").unwrap();
        assert_eq!(v["a"], "//x");
        assert_eq!(v["b"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn profiles_override_and_paths_map() {
        let dir = tmp();
        write(
            &dir,
            r#"{"host":"a","username":"u","remotePath":"/srv/app/","ignore":["node_modules"],
               "profiles":{"prod":{"host":"b","uploadOnSave":true}},"defaultProfile":"prod"}"#,
        );
        let c = &load(&dir, &HashMap::new()).unwrap()[0];
        assert_eq!(c.host, "b");
        assert!(c.upload_on_save);
        assert_eq!(c.remote_path, "/srv/app");
        assert_eq!(
            c.to_remote(&dir.join("src/x.js")).unwrap(),
            "/srv/app/src/x.js"
        );
        assert_eq!(
            c.to_local("/srv/app/src/x.js").unwrap(),
            dir.join("src/x.js")
        );
        assert!(c.to_local("/etc/passwd").is_none());
        assert!(c.is_ignored(&dir.join("node_modules/a/b.js"), false));
        assert!(c.is_ignored(&dir.join(".vscode/sftp.json"), false));
        assert!(!c.is_ignored(&dir.join("src/x.js"), false));

        let mut chosen = HashMap::new();
        chosen.insert(0, None);
        assert_eq!(load(&dir, &chosen).unwrap()[0].host, "a");
    }

    #[test]
    fn multiple_contexts_need_names() {
        let dir = tmp();
        write(
            &dir,
            r#"[{"name":"a","context":"web","host":"h","username":"u","remotePath":"/w"},
                {"name":"b","context":"api","host":"h","username":"u","remotePath":"/a",
                 "hop":{"host":"jump","username":"j"}}]"#,
        );
        let cs = load(&dir, &HashMap::new()).unwrap();
        assert_eq!(cs[0].context, dir.join("web"));
        assert_eq!(cs[1].hops[0].host, "jump");
        assert_eq!(cs[1].hops[0].port, 22);
    }

    #[test]
    fn monocode_config_used_when_no_vscode_config() {
        let dir = tmp();
        assert_eq!(config_path(&dir), dir.join(MONOCODE_CONFIG_RELATIVE));
        std::fs::create_dir_all(dir.join(".monocode")).unwrap();
        std::fs::write(
            dir.join(MONOCODE_CONFIG_RELATIVE),
            r#"{"host":"h","username":"u","remotePath":"/m"}"#,
        )
        .unwrap();
        let c = &load(&dir, &HashMap::new()).unwrap()[0];
        assert_eq!(c.remote_path, "/m");
        assert!(c.is_ignored(&dir.join(".monocode/sftp.json"), false));
        // An existing VS Code config takes precedence.
        write(&dir, r#"{"host":"h","username":"u","remotePath":"/v"}"#);
        assert_eq!(config_path(&dir), dir.join(CONFIG_RELATIVE));
        assert_eq!(load(&dir, &HashMap::new()).unwrap()[0].remote_path, "/v");
    }

    #[test]
    fn unsaved_entry_with_profile() {
        let dir = tmp();
        let entry = parse_jsonc(
            r#"{"host":"a","username":"u","remotePath":"/x","profiles":{"p":{"host":"b"}},"defaultProfile":"p"}"#,
        )
        .unwrap();
        let map = entry.as_object().unwrap();
        assert_eq!(resolve_unsaved(&dir, map, None).unwrap().host, "a");
        assert_eq!(
            resolve_unsaved(&dir, map, Some("p".into())).unwrap().host,
            "b"
        );
        let bad = parse_jsonc(r#"{"protocol":"sftp","username":"u"}"#).unwrap();
        assert!(resolve_unsaved(&dir, bad.as_object().unwrap(), None).is_err());
    }

    #[test]
    fn watcher_files_string_or_list() {
        let dir = tmp();
        write(
            &dir,
            r#"{"host":"h","username":"u","watcher":{"files":"**/*.css"}}"#,
        );
        let c = load(&dir, &HashMap::new()).unwrap().remove(0);
        assert_eq!(c.watcher.unwrap().files, vec!["**/*.css"]);
        write(
            &dir,
            r#"{"host":"h","username":"u","watcher":{"files":["dist/**/*.js","**/*.{css,map}"],"autoDelete":true}}"#,
        );
        let w = load(&dir, &HashMap::new())
            .unwrap()
            .remove(0)
            .watcher
            .unwrap();
        assert_eq!(w.files.len(), 2);
        assert!(w.auto_upload && w.auto_delete);
    }

    /// Every shape the setup form's watcher pickers generate must compile and match.
    #[test]
    fn generated_watcher_globs_match() {
        let check = |glob: &str, yes: &str, no: &str| {
            let g = globset::Glob::new(glob).unwrap().compile_matcher();
            assert!(g.is_match(yes), "{glob} should match {yes}");
            assert!(!g.is_match(no), "{glob} should not match {no}");
        };
        check("**/*.{css,map}", "a/b/x.css", "a/x.js");
        check("**/*{.css,.map}", "x.css.map", "x.js");
        check("dist/**/*.js", "dist/a/x.js", "src/x.js");
        check(
            "{dist,assets/css}/**/*.{css,map}",
            "assets/css/a.css",
            "assets/js/a.css",
        );
        check(
            "wp-content/themes/**/*",
            "wp-content/themes/t/style.css",
            "wp-content/plugins/p.php",
        );
    }

    #[test]
    fn remote_helpers() {
        assert_eq!(join_remote("/", "a/b"), "/a/b");
        assert_eq!(join_remote("/srv", ""), "/srv");
        assert_eq!(remote_parent("/srv/a"), Some("/srv".into()));
        assert_eq!(remote_parent("/a"), Some("/".into()));
        assert_eq!(remote_name("/srv/a.txt"), "a.txt");
    }
}
