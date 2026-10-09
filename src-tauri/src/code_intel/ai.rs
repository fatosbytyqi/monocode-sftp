//! AI inline completions through the Anthropic Messages API, with the user's
//! own API key kept in the OS keychain.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const KEYCHAIN_SERVICE: &str = "MonoCode SFTP";
const KEYCHAIN_ACCOUNT: &str = "anthropic-api-key";
const API_URL: &str = "https://api.anthropic.com/v1/messages";

const SYSTEM: &str = "You are an inline code completion engine inside a code editor. \
The user message holds the file content before the cursor in <prefix> and after it in <suffix>. \
Reply with only the text to insert at the cursor: no explanations, no markdown fences, \
and never repeat text that is already in the prefix or suffix. Prefer completing the current \
line or statement; insert at most a few lines. If nothing useful fits, reply with nothing.";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn api_key() -> Option<String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    entry()
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    saved: bool,
    from_env: bool,
}

#[tauri::command]
pub async fn ai_key_status() -> Result<KeyStatus, String> {
    let from_env = std::env::var("ANTHROPIC_API_KEY").is_ok_and(|k| !k.trim().is_empty());
    let saved = entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .is_some_and(|k| !k.trim().is_empty());
    Ok(KeyStatus { saved, from_env })
}

/// Save (or with `None`, delete) the API key in the keychain.
#[tauri::command]
pub async fn ai_set_key(key: Option<String>) -> Result<(), String> {
    let entry = entry()?;
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => entry.set_password(&k).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    prefix: String,
    suffix: String,
    path: String,
    model: String,
    max_tokens: u32,
}

fn tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

fn head(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Drop markdown fences and leading echo of the current line, which models
/// sometimes add despite instructions.
fn clean(text: &str, prefix: &str) -> String {
    let mut t = text.trim_end().to_string();
    if t.trim_start().starts_with("```") {
        let inner: Vec<&str> = t.lines().skip(1).collect();
        t = inner.join("\n");
        if let Some(i) = t.rfind("```") {
            t.truncate(i);
        }
        t = t.trim_end().to_string();
    }
    let line = prefix.rsplit('\n').next().unwrap_or("").trim_start();
    if !line.is_empty() && t.starts_with(line) {
        t = t[line.len()..].to_string();
    }
    t
}

fn request_body(req: &CompletionRequest) -> Value {
    let language = req.path.rsplit('.').next().unwrap_or("text");
    json!({
        "model": req.model,
        "max_tokens": req.max_tokens.clamp(16, 1024),
        "system": SYSTEM,
        "thinking": { "type": "disabled" },
        "output_config": { "effort": "low" },
        "messages": [{
            "role": "user",
            "content": format!(
                "File: {} ({language})\n<prefix>{}</prefix><suffix>{}</suffix>",
                req.path,
                tail(&req.prefix, 6000),
                head(&req.suffix, 2000)
            )
        }]
    })
}

#[tauri::command]
pub async fn ai_complete(request: CompletionRequest) -> Result<String, String> {
    let key = api_key().ok_or("No Anthropic API key. Add one in Settings → Code Editor.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let body = request_body(&request);
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(20))
            .build();
        let response = agent
            .post(API_URL)
            .set("x-api-key", &key)
            .set("anthropic-version", "2023-06-01")
            .set("content-type", "application/json")
            .send_string(&body.to_string());
        let json: Value = match response {
            Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(code, r)) => {
                let detail: Value = r
                    .into_string()
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or(Value::Null);
                let message = detail["error"]["message"]
                    .as_str()
                    .unwrap_or("request failed");
                return Err(format!("Anthropic API {code}: {message}"));
            }
            Err(e) => return Err(e.to_string()),
        };
        if json["stop_reason"] == "refusal" {
            return Ok(String::new());
        }
        let text: String = json["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        Ok(clean(&text, &request.prefix))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_fences_and_echo() {
        assert_eq!(clean("```php\necho 1;\n```", ""), "echo 1;");
        assert_eq!(clean("$a = 1;", "  $a"), " = 1;");
        assert_eq!(clean("foo()", "x\n"), "foo()");
    }

    #[test]
    fn trims_context_on_char_boundaries() {
        assert_eq!(tail("ab€cd", 3), "cd");
        assert_eq!(head("ab€cd", 3), "ab");
        let req = CompletionRequest {
            prefix: "a".repeat(10_000),
            suffix: String::new(),
            path: "x.php".into(),
            model: "claude-haiku-5-5".into(),
            max_tokens: 5000,
        };
        let body = request_body(&req);
        assert_eq!(body["max_tokens"], 1024);
        assert!(body["messages"][0]["content"].as_str().unwrap().len() < 6200);
    }
}
