import { useSyncExternalStore } from "react";

/** Language servers MonoCode can run, keyed by id. */
export type LspServerId = "php" | "typescript" | "css" | "html" | "json";

export type CompileStyle = "expanded" | "compressed";

export type CodeIntelSettings = {
  /** Suggest words already in the open file. */
  wordCompletion: boolean;
  /** Built-in snippets (PHP/WordPress, JS, CSS, HTML). */
  snippets: boolean;
  lsp: { enabled: boolean } & Record<LspServerId, boolean>;
  ai: {
    enabled: boolean;
    /** "auto" (first installed agent) or a provider id such as "codex". */
    provider: string;
    /** "auto" (the provider's default model) or a model id. */
    model: string;
    /** Wait this long after typing stops before asking. */
    debounceMs: number;
  };
  compile: {
    scss: boolean;
    less: boolean;
    style: CompileStyle;
    sourceMap: boolean;
    /** Output folder relative to the source file; empty = next to it. */
    outDir: string;
    /** Upload compiled CSS with SFTP when the project uploads on save. */
    uploadAfterCompile: boolean;
  };
};

export const DEFAULT_CODE_INTEL: CodeIntelSettings = {
  wordCompletion: true,
  snippets: true,
  lsp: {
    enabled: false,
    php: true,
    typescript: true,
    css: true,
    html: true,
    json: true,
  },
  ai: {
    enabled: false,
    provider: "auto",
    model: "auto",
    debounceMs: 700,
  },
  compile: {
    scss: false,
    less: false,
    style: "expanded",
    sourceMap: true,
    outDir: "",
    uploadAfterCompile: true,
  },
};

const KEY = "monocode.codeIntel.v1";
const CHANGE_EVENT = "monocode:codeintelchange";

function merge(saved: Partial<CodeIntelSettings> | null): CodeIntelSettings {
  const d = DEFAULT_CODE_INTEL;
  if (!saved || typeof saved !== "object") return structuredClone(d);
  return {
    wordCompletion: saved.wordCompletion ?? d.wordCompletion,
    snippets: saved.snippets ?? d.snippets,
    lsp: { ...d.lsp, ...(saved.lsp ?? {}) },
    ai: migrateAi({ ...d.ai, ...(saved.ai ?? {}) }, saved.ai),
    compile: { ...d.compile, ...(saved.compile ?? {}) },
  };
}

/** Earlier builds stored only a Claude model; keep it pointing at Claude. */
function migrateAi(
  ai: CodeIntelSettings["ai"],
  saved: Partial<CodeIntelSettings["ai"]> | undefined,
): CodeIntelSettings["ai"] {
  if (saved && !saved.provider && saved.model && saved.model !== "auto") {
    return { ...ai, provider: "claude" };
  }
  return ai;
}

let cached: CodeIntelSettings | null = null;

export function loadCodeIntel(): CodeIntelSettings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = merge(
      raw ? (JSON.parse(raw) as Partial<CodeIntelSettings>) : null,
    );
  } catch {
    cached = merge(null);
  }
  return cached;
}

export function saveCodeIntel(next: CodeIntelSettings) {
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function updateCodeIntel(
  patch: (current: CodeIntelSettings) => CodeIntelSettings,
) {
  saveCodeIntel(patch(loadCodeIntel()));
}

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function useCodeIntel(): CodeIntelSettings {
  return useSyncExternalStore(subscribe, loadCodeIntel, loadCodeIntel);
}

/** Which language server handles a file, if any. */
export function lspServerForPath(path: string): LspServerId | null {
  const name = path.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "php":
    case "phtml":
      return "php";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
      return "typescript";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "json":
    case "jsonc":
      return "json";
    default:
      return null;
  }
}

/** LSP `languageId` for a file. */
export function lspLanguageId(path: string): string {
  const ext = path.toLowerCase().slice(path.lastIndexOf(".") + 1);
  const map: Record<string, string> = {
    php: "php",
    phtml: "php",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascriptreact",
    ts: "typescript",
    tsx: "typescriptreact",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    json: "json",
    jsonc: "jsonc",
  };
  return map[ext] ?? "plaintext";
}
