//! Compile SCSS (built in, via grass) and Less (via the `less` npm package)
//! when a file is saved.
//!
//! A first-line comment can override settings per file, in the format the
//! VS Code "Easy LESS" / "Easy Sass" extensions use:
//!
//! `// out: ../css/style.css, compress: true, sourceMap: false`
//! `// main: ../style.scss`         (a partial: compile this file instead)
//! `// out: false`                  (never compile this file)

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::tools::{bin_script, command, node_binary, tools_dir};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileOptions {
    pub scss: bool,
    pub less: bool,
    /// "expanded" or "compressed".
    pub style: String,
    pub source_map: bool,
    /// Output folder relative to the source file; empty = next to it.
    pub out_dir: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    /// Files written (CSS and source maps).
    pub outputs: Vec<String>,
    pub errors: Vec<String>,
    /// Sources that were compiled.
    pub compiled: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Scss,
    Less,
}

fn kind_of(path: &Path) -> Option<Kind> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "scss" | "sass" => Some(Kind::Scss),
        "less" => Some(Kind::Less),
        _ => None,
    }
}

fn is_partial(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('_'))
}

#[derive(Debug, Default, PartialEq)]
struct Directive {
    out: Option<String>,
    main: Vec<String>,
    compress: Option<bool>,
    source_map: Option<bool>,
}

/// Parse the Easy LESS/Sass style first-line comment.
fn parse_directive(text: &str) -> Directive {
    let mut d = Directive::default();
    let Some(first) = text.lines().find(|l| !l.trim().is_empty()) else {
        return d;
    };
    let Some(body) = first.trim().strip_prefix("//") else {
        return d;
    };
    for part in body.split(',') {
        let Some((key, value)) = part.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim().to_ascii_lowercase(), value.trim().to_string());
        let flag = |v: &str| matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "1");
        match key.as_str() {
            "out" => d.out = Some(value),
            "main" => d.main.push(value),
            "compress" => d.compress = Some(flag(&value)),
            "sourcemap" => d.source_map = Some(flag(&value)),
            _ => {}
        }
    }
    d
}

/// Which non-partial files should be compiled when `saved` changes.
fn targets(saved: &Path, root: &Path, directive: &Directive) -> Vec<PathBuf> {
    let dir = saved.parent().unwrap_or(root);
    if !directive.main.is_empty() {
        return directive
            .main
            .iter()
            .map(|m| normalize(&dir.join(m)))
            .collect();
    }
    if !is_partial(saved) {
        return vec![saved.to_path_buf()];
    }
    // A partial: compile every non-partial sibling or ancestor-folder file of
    // the same kind that imports it by name.
    let kind = kind_of(saved);
    let stem = saved
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim_start_matches('_')
        .to_string();
    let mut out = Vec::new();
    let mut folder = Some(dir);
    let mut depth = 0;
    while let Some(d) = folder {
        scan_importers(d, kind, &stem, 3, &mut out);
        if d == root || depth > 6 {
            break;
        }
        folder = d.parent();
        depth += 1;
    }
    out.sort();
    out.dedup();
    out
}

fn scan_importers(
    dir: &Path,
    kind: Option<Kind>,
    stem: &str,
    levels: usize,
    out: &mut Vec<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if levels > 0 && !name.starts_with('.') && name != "node_modules" && name != "vendor" {
                scan_importers(&path, kind, stem, levels - 1, out);
            }
            continue;
        }
        if kind_of(&path) != kind || is_partial(&path) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let imports = text.lines().any(|l| {
            let l = l.trim_start();
            (l.starts_with("@import") || l.starts_with("@use") || l.starts_with("@forward"))
                && l.contains(stem)
        });
        if imports {
            out.push(path);
        }
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Where the CSS for `source` goes.
fn output_path(source: &Path, directive: &Directive, out_dir: &str) -> Option<PathBuf> {
    let dir = source.parent()?;
    let stem = source.file_stem()?.to_string_lossy().into_owned();
    match directive.out.as_deref() {
        Some(v) if matches!(v.to_ascii_lowercase().as_str(), "false" | "none" | "") => None,
        Some(v) => {
            let target = dir.join(v);
            if v.ends_with('/') || v.ends_with('\\') || target.is_dir() {
                Some(normalize(&target.join(format!("{stem}.css"))))
            } else {
                Some(normalize(&target))
            }
        }
        None if out_dir.trim().is_empty() => Some(dir.join(format!("{stem}.css"))),
        None => Some(normalize(
            &dir.join(out_dir.trim()).join(format!("{stem}.css")),
        )),
    }
}

fn compile_scss(
    source: &Path,
    out: &Path,
    root: &Path,
    compress: bool,
) -> Result<Vec<String>, String> {
    let dir = source.parent().unwrap_or(root);
    let style = if compress {
        grass::OutputStyle::Compressed
    } else {
        grass::OutputStyle::Expanded
    };
    let options = grass::Options::default()
        .style(style)
        .quiet(true)
        .load_paths(&[
            dir.to_path_buf(),
            root.to_path_buf(),
            root.join("node_modules"),
        ]);
    let css =
        grass::from_path(source, &options).map_err(|e| format!("{}: {e}", source.display()))?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(out, css).map_err(|e| format!("{}: {e}", out.display()))?;
    Ok(vec![out.to_string_lossy().into_owned()])
}

fn compile_less(
    app: &AppHandle,
    source: &Path,
    out: &Path,
    compress: bool,
    source_map: bool,
) -> Result<Vec<String>, String> {
    let dir = tools_dir(app)?;
    let lessc = bin_script(&dir, "less", "lessc").ok_or(
        "The Less compiler is not installed. Install it in Settings → Code Editor → Compile.",
    )?;
    let node = node_binary().ok_or("Node.js was not found. Install it from https://nodejs.org.")?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cmd = command(&node);
    cmd.arg(lessc).arg("--no-color");
    if compress {
        cmd.arg("--compress");
    }
    if source_map {
        cmd.arg("--source-map");
    }
    cmd.arg(source).arg(out);
    if let Some(d) = source.parent() {
        cmd.current_dir(d);
    }
    let output = cmd.output().map_err(|e| format!("lessc: {e}"))?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if msg.is_empty() {
            format!("lessc failed ({})", output.status)
        } else {
            msg
        });
    }
    let mut written = vec![out.to_string_lossy().into_owned()];
    let map = PathBuf::from(format!("{}.map", out.display()));
    if source_map && map.exists() {
        written.push(map.to_string_lossy().into_owned());
    }
    Ok(written)
}

/// Compile after `path` was saved. Returns empty results for other file types
/// or when that language is switched off.
#[tauri::command]
pub async fn style_compile(
    app: AppHandle,
    path: String,
    root: String,
    options: CompileOptions,
) -> Result<CompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let saved = PathBuf::from(&path);
        let root = if root.is_empty() || root == "~" {
            saved.parent().map(Path::to_path_buf).unwrap_or_default()
        } else {
            PathBuf::from(root)
        };
        let mut result = CompileResult::default();
        let Some(kind) = kind_of(&saved) else {
            return Ok(result);
        };
        if (kind == Kind::Scss && !options.scss) || (kind == Kind::Less && !options.less) {
            return Ok(result);
        }
        let text = std::fs::read_to_string(&saved).unwrap_or_default();
        let saved_directive = parse_directive(&text);
        for source in targets(&saved, &root, &saved_directive) {
            let directive = if source == saved {
                saved_directive.clone_shallow()
            } else {
                parse_directive(&std::fs::read_to_string(&source).unwrap_or_default())
            };
            if is_partial(&source) && directive.main.is_empty() {
                continue;
            }
            let Some(out) = output_path(&source, &directive, &options.out_dir) else {
                continue;
            };
            let compress = directive.compress.unwrap_or(options.style == "compressed");
            let source_map = directive.source_map.unwrap_or(options.source_map);
            let compiled = match kind_of(&source) {
                Some(Kind::Scss) => compile_scss(&source, &out, &root, compress),
                Some(Kind::Less) => compile_less(&app, &source, &out, compress, source_map),
                None => continue,
            };
            match compiled {
                Ok(files) => {
                    result.compiled.push(source.to_string_lossy().into_owned());
                    result.outputs.extend(files);
                }
                Err(e) => result.errors.push(e),
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

impl Directive {
    fn clone_shallow(&self) -> Directive {
        Directive {
            out: self.out.clone(),
            main: vec![],
            compress: self.compress,
            source_map: self.source_map,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("style-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn directive_parsing() {
        let d =
            parse_directive("// out: ../css/style.css, compress: true, sourceMap: false\nbody{}");
        assert_eq!(d.out.as_deref(), Some("../css/style.css"));
        assert_eq!(d.compress, Some(true));
        assert_eq!(d.source_map, Some(false));
        assert_eq!(
            parse_directive("// main: ../style.less").main,
            vec!["../style.less"]
        );
        assert_eq!(parse_directive("body{}"), Directive::default());
    }

    #[test]
    fn output_paths() {
        let src = Path::new("/p/scss/style.scss");
        let none = Directive::default();
        assert_eq!(
            output_path(src, &none, "").unwrap(),
            Path::new("/p/scss/style.css")
        );
        assert_eq!(
            output_path(src, &none, "../css").unwrap(),
            Path::new("/p/css/style.css")
        );
        let d = Directive {
            out: Some("../dist/app.min.css".into()),
            ..Default::default()
        };
        assert_eq!(
            output_path(src, &d, "").unwrap(),
            Path::new("/p/dist/app.min.css")
        );
        let off = Directive {
            out: Some("false".into()),
            ..Default::default()
        };
        assert!(output_path(src, &off, "").is_none());
    }

    #[test]
    fn compiles_scss_and_resolves_partials() {
        let dir = tmp();
        std::fs::write(dir.join("_vars.scss"), "$c: #f00;").unwrap();
        std::fs::write(
            dir.join("style.scss"),
            "@use 'vars';\n.a { color: vars.$c; .b { margin: 0 } }",
        )
        .unwrap();
        let partial = dir.join("_vars.scss");
        let found = targets(&partial, &dir, &Directive::default());
        assert_eq!(found, vec![dir.join("style.scss")]);
        let out = dir.join("style.css");
        compile_scss(&dir.join("style.scss"), &out, &dir, false).unwrap();
        let css = std::fs::read_to_string(&out).unwrap();
        assert!(css.contains(".a .b"), "{css}");
        assert!(css.contains("red") || css.contains("#f00"), "{css}");
        compile_scss(&dir.join("style.scss"), &out, &dir, true).unwrap();
        let min = std::fs::read_to_string(&out).unwrap();
        assert!(min.trim().lines().count() == 1, "{min}");
        std::fs::write(dir.join("bad.scss"), ".a { color: $missing; }").unwrap();
        let err =
            compile_scss(&dir.join("bad.scss"), &dir.join("bad.css"), &dir, false).unwrap_err();
        assert!(
            err.contains("missing") || err.contains("Undefined"),
            "{err}"
        );
    }
}
