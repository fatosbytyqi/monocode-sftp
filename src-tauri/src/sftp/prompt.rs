//! Asking the user for passwords, passphrases, verification codes and host-key
//! trust. Rust emits `sftp-prompt`; the UI answers with `sftp_prompt_reply`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub id: String,
    pub title: String,
    pub message: String,
    /// Hide typed characters.
    pub secret: bool,
    /// Yes/no question instead of a text field.
    pub confirm: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub level: &'static str,
    pub message: String,
    pub time: u64,
}

type EmitFn = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;

pub struct Ctx {
    emitter: EmitFn,
    pending: Mutex<HashMap<String, oneshot::Sender<Option<String>>>>,
    /// Secrets typed this app session, so a reconnect does not ask again.
    secrets: Mutex<HashMap<String, String>>,
}

const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

impl Ctx {
    pub fn new(app: AppHandle) -> Self {
        Self::with_emitter(Box::new(move |event, payload| {
            let _ = app.emit(event, payload);
        }))
    }

    pub fn with_emitter(emitter: EmitFn) -> Self {
        Self {
            emitter,
            pending: Mutex::new(HashMap::new()),
            secrets: Mutex::new(HashMap::new()),
        }
    }

    pub fn emit<T: Serialize>(&self, event: &str, payload: T) {
        if let Ok(value) = serde_json::to_value(payload) {
            (self.emitter)(event, value);
        }
    }

    pub fn log(&self, level: &'static str, message: impl Into<String>) {
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.emit(
            "sftp-log",
            LogLine {
                level,
                message: message.into(),
                time,
            },
        );
    }

    pub fn info(&self, message: impl Into<String>) {
        self.log("info", message);
    }

    pub fn error(&self, message: impl Into<String>) {
        self.log("error", message);
    }

    async fn ask_raw(
        &self,
        title: &str,
        message: &str,
        secret: bool,
        confirm: bool,
    ) -> Option<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let request = PromptRequest {
            id: id.clone(),
            title: title.into(),
            message: message.into(),
            secret,
            confirm,
        };
        self.emit("sftp-prompt", request);
        let answer = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;
        self.pending.lock().unwrap().remove(&id);
        match answer {
            Ok(Ok(value)) => value,
            _ => None,
        }
    }

    pub async fn ask(&self, title: &str, message: &str, secret: bool) -> Option<String> {
        self.ask_raw(title, message, secret, false).await
    }

    pub async fn confirm(&self, title: &str, message: &str) -> bool {
        self.ask_raw(title, message, false, true).await.as_deref() == Some("yes")
    }

    /// Ask once per app session for `key`; cached until `forget`.
    pub async fn secret(&self, key: &str, title: &str, message: &str) -> Option<String> {
        if let Some(found) = self.secrets.lock().unwrap().get(key).cloned() {
            return Some(found);
        }
        let value = self.ask(title, message, true).await?;
        self.secrets
            .lock()
            .unwrap()
            .insert(key.to_string(), value.clone());
        Some(value)
    }

    pub fn forget(&self, key: &str) {
        self.secrets.lock().unwrap().remove(key);
    }

    pub fn reply(&self, id: &str, value: Option<String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(value);
        }
    }
}
