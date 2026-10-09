//! End-to-end checks against a real SSH server. Ignored by default; run with
//!
//! SFTP_E2E_DIR=/tmp/sftp-e2e SFTP_E2E_KEY=/tmp/sftp-e2e/keys/client_ed25519 \
//! SFTP_E2E_PORT=2222 MONOCODE_SFTP_KNOWN_HOSTS=/tmp/sftp-e2e/known_hosts \
//!   cargo test -p monocode --lib sftp::e2e -- --ignored --test-threads=1
//!
//! The server must expose SFTP for the current user on 127.0.0.1 and accept the key.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::config;
use super::ops::{Direction, Recent, Run};
use super::prompt::Ctx;
use super::remote::Remote;

struct Env {
    workspace: PathBuf,
    remote_root: PathBuf,
    key: String,
    port: u16,
}

fn env(name: &str) -> Option<Env> {
    let dir = PathBuf::from(std::env::var("SFTP_E2E_DIR").ok()?);
    let workspace = dir.join(format!("ws-{name}"));
    let remote_root = dir.join("remote").join(name);
    let _ = std::fs::remove_dir_all(&workspace);
    let _ = std::fs::remove_dir_all(&remote_root);
    std::fs::create_dir_all(workspace.join(".vscode")).unwrap();
    std::fs::create_dir_all(&remote_root).unwrap();
    Some(Env {
        workspace,
        remote_root,
        key: std::env::var("SFTP_E2E_KEY").ok()?,
        port: std::env::var("SFTP_E2E_PORT").ok()?.parse().ok()?,
    })
}

fn ctx() -> Arc<Ctx> {
    Arc::new(Ctx::with_emitter(Box::new(|event, payload| {
        if event == "sftp-prompt" {
            panic!("unexpected prompt: {payload}");
        }
        if event == "sftp-log" {
            eprintln!("  [log] {}", payload["message"].as_str().unwrap_or(""));
        }
    })))
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

async fn run_for(e: &Env, extra: &str) -> Run {
    let user = std::env::var("USER").unwrap();
    write(
        &e.workspace.join(".vscode/sftp.json"),
        &format!(
            r#"{{
              // comments are allowed
              "name": "e2e",
              "host": "127.0.0.1",
              "port": {port},
              "username": "{user}",
              "privateKeyPath": "{key}",
              "remotePath": "{remote}",
              "ignore": ["node_modules", ".vscode"],
              {extra}
            }}"#,
            port = e.port,
            key = e.key,
            remote = e.remote_root.display(),
        ),
    );
    let cfg = config::load(&e.workspace, &HashMap::new())
        .unwrap()
        .remove(0);
    let ctx = ctx();
    let remote = Arc::new(Remote::connect(&ctx, &cfg).await.expect("connect"));
    Run {
        ctx,
        remote,
        cfg: Arc::new(cfg),
        cancel: CancellationToken::new(),
        recent: Arc::new(Recent::default()),
        running: Arc::new(AtomicUsize::new(0)),
        force: false,
        label: "e2e".into(),
    }
}

#[tokio::test]
#[ignore]
async fn e2e_upload_download_ignore_list_delete() {
    let Some(e) = env("basic") else { return };
    write(&e.workspace.join("index.html"), "<h1>hi</h1>");
    write(&e.workspace.join("css/site.css"), "body{}");
    write(&e.workspace.join("node_modules/x/y.js"), "ignored");
    let run = run_for(&e, r#""useTempFile": true, "concurrency": 3"#).await;

    let s = run.upload(std::slice::from_ref(&e.workspace)).await;
    assert_eq!(s.failed, 0, "{:?}", s.errors);
    assert_eq!(s.uploaded, 2);
    assert_eq!(read(&e.remote_root.join("index.html")), "<h1>hi</h1>");
    assert_eq!(read(&e.remote_root.join("css/site.css")), "body{}");
    assert!(!e.remote_root.join("node_modules").exists(), "ignore rules");
    assert!(
        !e.remote_root.join(".vscode").exists(),
        "config never uploaded"
    );
    // useTempFile leaves no temp files behind.
    let leftovers: Vec<_> = std::fs::read_dir(&e.remote_root)
        .unwrap()
        .flatten()
        .filter(|d| d.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());

    // Overwrite an existing remote file (temp file + rename over it).
    write(&e.workspace.join("index.html"), "<h1>v2</h1>");
    let s = run.upload(&[e.workspace.join("index.html")]).await;
    assert_eq!(s.uploaded, 1, "{:?}", s.errors);
    assert_eq!(read(&e.remote_root.join("index.html")), "<h1>v2</h1>");

    // Download picks up server-side edits.
    write(&e.remote_root.join("css/site.css"), "body{color:red}");
    write(&e.remote_root.join("server-only.txt"), "from server");
    let s = run
        .download(&[format!("{}/css/site.css", e.remote_root.display())])
        .await;
    assert_eq!(s.downloaded, 1, "{:?}", s.errors);
    assert_eq!(read(&e.workspace.join("css/site.css")), "body{color:red}");

    // Remote listing.
    let root = e.remote_root.to_string_lossy().to_string();
    let mut names: Vec<String> = run
        .remote
        .list(&root)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    names.sort();
    assert_eq!(names, vec!["css", "index.html", "server-only.txt"]);

    // Force upload ignores the ignore rules.
    let forced = Run {
        force: true,
        ..run_clone(&run)
    };
    let s = forced.upload(&[e.workspace.join("node_modules")]).await;
    assert_eq!(s.uploaded, 1, "{:?}", s.errors);
    assert_eq!(read(&e.remote_root.join("node_modules/x/y.js")), "ignored");

    // Delete a remote folder recursively.
    let s = run
        .delete_remote(&[format!("{}/node_modules", e.remote_root.display())])
        .await;
    assert_eq!(s.deleted, 1, "{:?}", s.errors);
    assert!(!e.remote_root.join("node_modules").exists());
}

fn run_clone(r: &Run) -> Run {
    Run {
        ctx: r.ctx.clone(),
        remote: r.remote.clone(),
        cfg: r.cfg.clone(),
        cancel: r.cancel.clone(),
        recent: r.recent.clone(),
        running: r.running.clone(),
        force: r.force,
        label: r.label.clone(),
    }
}

#[tokio::test]
#[ignore]
async fn e2e_sync_directions_and_options() {
    let Some(e) = env("sync") else { return };
    write(&e.workspace.join("a.txt"), "a");
    write(&e.workspace.join("dir/b.txt"), "b");
    let run = run_for(&e, r#""syncOption": { "delete": true }"#).await;

    // local -> remote creates everything.
    let s = run.sync(&e.workspace, Direction::LocalToRemote).await;
    assert_eq!((s.uploaded, s.failed), (2, 0), "{:?}", s.errors);
    assert_eq!(read(&e.remote_root.join("dir/b.txt")), "b");

    // Unchanged files are skipped on the next run (mtimes were preserved).
    let s = run.sync(&e.workspace, Direction::LocalToRemote).await;
    assert_eq!(s.uploaded, 0, "nothing changed");

    // delete: extra remote files go away on local -> remote.
    write(&e.remote_root.join("stale.txt"), "old");
    std::fs::remove_file(e.workspace.join("a.txt")).unwrap();
    let s = run.sync(&e.workspace, Direction::LocalToRemote).await;
    assert_eq!(s.deleted, 2, "{:?}", s.errors);
    assert!(!e.remote_root.join("stale.txt").exists());
    assert!(!e.remote_root.join("a.txt").exists());

    // remote -> local brings new server files down.
    write(&e.remote_root.join("dir/new.txt"), "new");
    let s = run.sync(&e.workspace, Direction::RemoteToLocal).await;
    assert_eq!(s.downloaded, 1, "{:?}", s.errors);
    assert_eq!(read(&e.workspace.join("dir/new.txt")), "new");

    // both: newer side wins, one-sided files are copied across.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    write(&e.workspace.join("dir/b.txt"), "b-local-newer");
    write(&e.remote_root.join("only-remote.txt"), "r");
    write(&e.workspace.join("only-local.txt"), "l");
    let s = run.sync(&e.workspace, Direction::Both).await;
    assert_eq!(s.failed, 0, "{:?}", s.errors);
    assert_eq!(read(&e.remote_root.join("dir/b.txt")), "b-local-newer");
    assert_eq!(read(&e.workspace.join("only-remote.txt")), "r");
    assert_eq!(read(&e.remote_root.join("only-local.txt")), "l");
}

#[tokio::test]
#[ignore]
async fn e2e_jump_host_and_ignore_existing() {
    let Some(e) = env("hop") else { return };
    let user = std::env::var("USER").unwrap();
    write(&e.workspace.join("x.txt"), "x");
    // Hop through the same server to itself: exercises direct-tcpip chaining.
    let run = run_for(
        &e,
        &format!(
            r#""hop": {{ "host": "127.0.0.1", "port": {}, "username": "{user}", "privateKeyPath": "{}" }},
               "syncOption": {{ "ignoreExisting": true }}"#,
            e.port, e.key
        ),
    )
    .await;
    let s = run.upload(&[e.workspace.join("x.txt")]).await;
    assert_eq!(s.uploaded, 1, "{:?}", s.errors);
    write(&e.workspace.join("x.txt"), "changed");
    let s = run.sync(&e.workspace, Direction::LocalToRemote).await;
    assert_eq!(
        s.uploaded, 0,
        "ignoreExisting skips files already on the server"
    );
    assert_eq!(read(&e.remote_root.join("x.txt")), "x");
}

/// FTP: needs SFTP_E2E_FTP_PORT and SFTP_E2E_FTP_ROOT (the server's root folder
/// on disk) for user `test` / password `secret`.
#[tokio::test]
#[ignore]
async fn e2e_ftp_upload_download_sync() {
    let (Ok(port), Ok(root)) = (
        std::env::var("SFTP_E2E_FTP_PORT"),
        std::env::var("SFTP_E2E_FTP_ROOT"),
    ) else {
        return;
    };
    let Some(e) = env("ftp") else { return };
    let disk = PathBuf::from(root).join("ftp-site");
    let _ = std::fs::remove_dir_all(&disk);
    write(&e.workspace.join("index.php"), "<?php echo 1;");
    write(&e.workspace.join("img/logo.svg"), "<svg/>");
    write(
        &e.workspace.join(".vscode/sftp.json"),
        &format!(
            r#"{{ "protocol": "ftp", "host": "127.0.0.1", "port": {port},
                 "username": "test", "password": "secret", "remotePath": "/ftp-site",
                 "useTempFile": true, "syncOption": {{ "delete": true }} }}"#
        ),
    );
    let cfg = config::load(&e.workspace, &HashMap::new())
        .unwrap()
        .remove(0);
    let ctx = ctx();
    let remote = Arc::new(Remote::connect(&ctx, &cfg).await.expect("ftp connect"));
    let run = Run {
        ctx,
        remote,
        cfg: Arc::new(cfg),
        cancel: CancellationToken::new(),
        recent: Arc::new(Recent::default()),
        running: Arc::new(AtomicUsize::new(0)),
        force: false,
        label: "ftp".into(),
    };
    let s = run.upload(std::slice::from_ref(&e.workspace)).await;
    assert_eq!((s.uploaded, s.failed), (2, 0), "{:?}", s.errors);
    assert_eq!(read(&disk.join("index.php")), "<?php echo 1;");
    assert_eq!(read(&disk.join("img/logo.svg")), "<svg/>");

    write(&disk.join("img/logo.svg"), "<svg id='server'/>");
    let s = run.download(&["/ftp-site/img/logo.svg".into()]).await;
    assert_eq!(s.downloaded, 1, "{:?}", s.errors);
    assert_eq!(
        read(&e.workspace.join("img/logo.svg")),
        "<svg id='server'/>"
    );

    write(&disk.join("old.txt"), "stale");
    let s = run.sync(&e.workspace, Direction::LocalToRemote).await;
    assert_eq!(s.failed, 0, "{:?}", s.errors);
    assert!(
        !disk.join("old.txt").exists(),
        "delete extraneous remote files"
    );

    let mut names: Vec<String> = run
        .remote
        .list("/ftp-site")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    names.sort();
    assert_eq!(names, vec!["img", "index.php"]);
    let s = run.delete_remote(&["/ftp-site/img".into()]).await;
    assert_eq!(s.deleted, 1, "{:?}", s.errors);
    assert!(!disk.join("img").exists());
}
