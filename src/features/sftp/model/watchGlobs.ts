/**
 * The file watcher's `files` setting, edited as tags: file types, folders and
 * free-form glob patterns. The app writes the glob; people never have to.
 */

export type WatchSelection = {
  /** Extensions without the dot: ["css", "map"]. */
  extensions: string[];
  /** Folders relative to the local root: ["dist", "assets/css"]. */
  folders: string[];
  /** Anything the builder can't express, kept verbatim. */
  patterns: string[];
};

export const EMPTY_SELECTION: WatchSelection = {
  extensions: [],
  folders: [],
  patterns: [],
};

export const EXTENSION_PRESETS: { label: string; extensions: string[] }[] = [
  { label: "Styles", extensions: ["css", "scss", "map"] },
  { label: "Scripts", extensions: ["js", "mjs", "map"] },
  {
    label: "Images",
    extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico"],
  },
  { label: "Fonts", extensions: ["woff", "woff2", "ttf", "otf", "eot"] },
  { label: "PHP", extensions: ["php"] },
  { label: "HTML", extensions: ["html", "htm"] },
  { label: "Templates", extensions: ["twig", "blade.php", "tpl"] },
  { label: "Data", extensions: ["json", "xml", "yml", "yaml"] },
];

export function normalizeExtension(raw: string): string {
  return raw
    .trim()
    .replace(/^\*+/, "")
    .replace(/^\.+/, "")
    .replace(/[{}*,/\s]/g, "");
}

export function normalizeFolder(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/\*\*$/, "")
    .replace(/[{}*,]/g, "");
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function group(items: string[]): string {
  return items.length === 1 ? items[0]! : `{${items.join(",")}}`;
}

/** The glob for the extension/folder part of a selection, or null if none. */
export function generatedGlob(sel: WatchSelection): string | null {
  const extensions = uniq(sel.extensions.map(normalizeExtension));
  const folders = uniq(sel.folders.map(normalizeFolder));
  if (!extensions.length && !folders.length) return null;
  const file = extensions.length ? `*.${group(extensions)}` : "*";
  const base = folders.length ? `${group(folders)}/**` : "**";
  return `${base}/${file}`;
}

/** Selection -> `watcher.files` (a string when possible, for VS Code compatibility). */
export function buildWatchFiles(sel: WatchSelection): string | string[] {
  const all = uniq([
    ...(generatedGlob(sel) ? [generatedGlob(sel)!] : []),
    ...sel.patterns.map((p) => p.trim()),
  ]);
  if (all.length === 0) return "**/*";
  return all.length === 1 ? all[0]! : all;
}

const GENERATED =
  /^(?:\{([^{}]+)\}\/\*\*|([^*{}]+)\/\*\*|\*\*)\/\*(?:\.\{([^{}]+)\}|\.([^*{}/]+)|\{(\.[^{}]+)\})?$/;

function splitGroup(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `watcher.files` -> selection. Patterns it can't decompose stay as custom patterns. */
export function parseWatchFiles(files: unknown): WatchSelection {
  const list = (Array.isArray(files) ? files : [files]).filter(
    (f): f is string => typeof f === "string" && f.trim() !== "",
  );
  const sel: WatchSelection = { extensions: [], folders: [], patterns: [] };
  let generatedTaken = false;
  for (const pattern of list) {
    const trimmed = pattern.trim();
    if (trimmed === "**/*" || trimmed === "**") continue;
    const m = generatedTaken ? null : GENERATED.exec(trimmed);
    if (!m) {
      sel.patterns.push(trimmed);
      continue;
    }
    generatedTaken = true;
    const [, folderGroup, folder, extGroup, ext, dottedGroup] = m;
    if (folderGroup)
      sel.folders.push(...splitGroup(folderGroup).map(normalizeFolder));
    if (folder) sel.folders.push(normalizeFolder(folder));
    if (extGroup)
      sel.extensions.push(...splitGroup(extGroup).map(normalizeExtension));
    if (ext) sel.extensions.push(normalizeExtension(ext));
    if (dottedGroup)
      sel.extensions.push(...splitGroup(dottedGroup).map(normalizeExtension));
  }
  sel.extensions = uniq(sel.extensions);
  sel.folders = uniq(sel.folders);
  return sel;
}

/** Whether a project-relative path is selected (custom patterns are not evaluated). */
export function selectionMatches(
  sel: WatchSelection,
  relative: string,
): boolean {
  const path = relative.replace(/\\/g, "/");
  const folders = sel.folders.map(normalizeFolder).filter(Boolean);
  if (folders.length && !folders.some((f) => path.startsWith(`${f}/`)))
    return false;
  const extensions = sel.extensions.map(normalizeExtension).filter(Boolean);
  if (!extensions.length) return true;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return extensions.some((e) => name.endsWith(`.${e.toLowerCase()}`));
}

/** Most common extensions and folders in a project, for suggestions. */
export function projectSuggestions(relatives: string[]): {
  extensions: string[];
  folders: string[];
} {
  const ext = new Map<string, number>();
  const dirs = new Map<string, number>();
  for (const rel of relatives) {
    const path = rel.replace(/\\/g, "/");
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "";
    const dot = name.lastIndexOf(".");
    if (dot > 0 && dot < name.length - 1) {
      const e = name.slice(dot + 1).toLowerCase();
      if (e.length <= 8) ext.set(e, (ext.get(e) ?? 0) + 1);
    }
    for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
      const dir = parts.slice(0, depth).join("/");
      if (dir.startsWith(".")) break;
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([k]) => k);
  return { extensions: top(ext, 24), folders: top(dirs, 24) };
}
