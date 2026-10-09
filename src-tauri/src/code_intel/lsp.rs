//! Language servers over stdio. The editor's LSP client sends JSON messages
//! with `lsp_send`; server messages come back as `lsp-message` events.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::tools::{bin_script, command, node_binary, spec, tools_dir};

struct Server {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

#[derive(Default)]
pub struct LspHost {
    servers: Mutex<HashMap<String, Server>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspMessage {
    id: String,
    message: String,
}

/// Read one `Content-Length` framed message.
fn read_message(reader: &mut impl BufRead) -> Option<String> {
    let mut length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line
            .strip_prefix("Content-Length:")
            .or_else(|| line.strip_prefix("content-length:"))
        {
            length = value.trim().parse().ok();
        }
    }
    let mut body = vec![0u8; length?];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

/// Start a language server for `server` ("php", "typescript", …) rooted at `root`.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    host: State<'_, LspHost>,
    server: String,
    root: String,
) -> Result<String, String> {
    let tool = spec(&server).ok_or_else(|| format!("Unknown language server {server}"))?;
    let dir = tools_dir(&app)?;
    let script = bin_script(&dir, tool.bin.0, tool.bin.1).ok_or_else(|| {
        format!(
            "{} is not installed. Install it in Settings → Code Editor.",
            tool.label
        )
    })?;
    let node = node_binary().ok_or("Node.js was not found. Install it from https://nodejs.org.")?;
    let mut cmd = command(&node);
    cmd.arg(script)
        .arg("--stdio")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", tool.label))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let id = uuid::Uuid::new_v4().to_string();

    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(message) = read_message(&mut reader) {
            let _ = app_out.emit(
                "lsp-message",
                LspMessage {
                    id: id_out.clone(),
                    message,
                },
            );
        }
        let _ = app_out.emit("lsp-exit", id_out);
    });
    if let Some(stderr) = stderr {
        // Drain so a chatty server never blocks on a full pipe.
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = BufReader::new(stderr).read_to_end(&mut sink);
        });
    }
    host.servers.lock().unwrap().insert(
        id.clone(),
        Server {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn lsp_send(host: State<'_, LspHost>, id: String, message: String) -> Result<(), String> {
    let stdin = host
        .servers
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.stdin.clone())
        .ok_or("Language server is not running")?;
    let mut stdin = stdin.lock().unwrap();
    write!(
        stdin,
        "Content-Length: {}\r\n\r\n{}",
        message.len(),
        message
    )
    .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(host: State<'_, LspHost>, id: String) -> Result<(), String> {
    if let Some(server) = host.servers.lock().unwrap().remove(&id) {
        let _ = server.child.lock().unwrap().kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_message;

    #[test]
    fn reads_framed_messages() {
        let raw =
            b"Content-Length: 7\r\nContent-Type: x\r\n\r\n{\"a\":1}Content-Length: 2\r\n\r\n{}";
        let mut reader = std::io::BufReader::new(&raw[..]);
        assert_eq!(read_message(&mut reader).unwrap(), "{\"a\":1}");
        assert_eq!(read_message(&mut reader).unwrap(), "{}");
        assert!(read_message(&mut reader).is_none());
    }
}
