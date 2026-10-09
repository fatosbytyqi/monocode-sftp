//! npm-installed helper tools (language servers, the Less compiler), kept in
//! the app's data folder so nothing is installed globally.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::harness::{gui_search_path, resolve_gui_binary};

/// A tool the user can install, and the npm packages it needs.
pub struct ToolSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub packages: &'static [&'static str],
    /// (package, bin name) whose script is launched with node.
    pub bin: (&'static str, &'static str),
}

pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        id: "php",
        label: "PHP (Intelephense)",
        packages: &["intelephense"],
        bin: ("intelephense", "intelephense"),
    },
    ToolSpec {
        id: "typescript",
        label: "JavaScript / TypeScript",
        packages: &["typescript-language-server", "typescript"],
        bin: ("typescript-language-server", "typescript-language-server"),
    },
    ToolSpec {
        id: "css",
        label: "CSS / SCSS / Less",
        packages: &["vscode-langservers-extracted"],
        bin: ("vscode-langservers-extracted", "vscode-css-language-server"),
    },
    ToolSpec {
        id: "html",
        label: "HTML",
        packages: &["vscode-langservers-extracted"],
        bin: (
            "vscode-langservers-extracted",
            "vscode-html-language-server",
        ),
    },
    ToolSpec {
        id: "json",
        label: "JSON",
        packages: &["vscode-langservers-extracted"],
        bin: (
            "vscode-langservers-extracted",
            "vscode-json-language-server",
        ),
    },
    ToolSpec {
        id: "less",
        label: "Less compiler",
        packages: &["less"],
        bin: ("less", "lessc"),
    },
];

pub fn spec(id: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.id == id)
}

pub fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tools"))
}

pub fn node_binary() -> Option<PathBuf> {
    resolve_gui_binary("node")
}

fn npm_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(p) = resolve_gui_binary("npm.cmd") {
        return Some(p);
    }
    resolve_gui_binary("npm")
}

pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", gui_search_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn package_dir(dir: &Path, package: &str) -> PathBuf {
    dir.join("node_modules").join(package)
}

fn installed_version(dir: &Path, package: &str) -> Option<String> {
    let text = std::fs::read_to_string(package_dir(dir, package).join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// The JS file behind a package's `bin` entry.
pub fn bin_script(dir: &Path, package: &str, bin: &str) -> Option<PathBuf> {
    let root = package_dir(dir, package);
    let text = std::fs::read_to_string(root.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let rel = match json.get("bin")? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(map) => map.get(bin)?.as_str()?.to_string(),
        _ => return None,
    };
    let path = root.join(rel);
    path.exists().then_some(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    id: &'static str,
    label: &'static str,
    installed: bool,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    node: Option<String>,
    node_version: Option<String>,
    npm: bool,
    dir: String,
    tools: Vec<ToolStatus>,
}

#[tauri::command]
pub async fn code_tools_status(app: AppHandle) -> Result<ToolsStatus, String> {
    let dir = tools_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let node = node_binary();
        let node_version = node.as_ref().and_then(|n| {
            command(n)
                .arg("--version")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        });
        let tools = TOOLS
            .iter()
            .map(|t| {
                let version = installed_version(&dir, t.bin.0);
                ToolStatus {
                    id: t.id,
                    label: t.label,
                    installed: version.is_some() && bin_script(&dir, t.bin.0, t.bin.1).is_some(),
                    version,
                }
            })
            .collect();
        Ok(ToolsStatus {
            node: node.map(|n| n.to_string_lossy().into_owned()),
            node_version,
            npm: npm_binary().is_some(),
            dir: dir.to_string_lossy().into_owned(),
            tools,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `npm install` the packages for the given tools into the tools folder.
#[tauri::command]
pub async fn code_tools_install(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let dir = tools_dir(&app)?;
    let mut packages: Vec<&str> = ids
        .iter()
        .filter_map(|id| spec(id))
        .flat_map(|t| t.packages.iter().copied())
        .collect();
    packages.sort();
    packages.dedup();
    if packages.is_empty() {
        return Ok(());
    }
    let npm = npm_binary().ok_or(
        "npm was not found. Install Node.js from https://nodejs.org (it includes npm), then try again.",
    )?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let manifest = dir.join("package.json");
    if !manifest.exists() {
        let _ = std::fs::write(
            &manifest,
            "{\n  \"name\": \"monocode-tools\",\n  \"private\": true\n}\n",
        );
    }
    let log = |line: String| {
        let _ = app.emit("code-tools-log", line);
    };
    log(format!("npm install {}", packages.join(" ")));
    let app2 = app.clone();
    let dir2 = dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&npm);
        cmd.current_dir(&dir2)
            .args([
                "install",
                "--no-audit",
                "--no-fund",
                "--loglevel=error",
                "--save",
            ])
            .args(&packages)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = cmd.output().map_err(|e| format!("npm: {e}"))?;
        for line in String::from_utf8_lossy(&output.stdout)
            .lines()
            .chain(String::from_utf8_lossy(&output.stderr).lines())
        {
            if !line.trim().is_empty() {
                let _ = app2.emit("code-tools-log", line.to_string());
            }
        }
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("npm install failed ({})", output.status))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    log(match &result {
        Ok(()) => "Installed.".to_string(),
        Err(e) => e.clone(),
    });
    result
}
