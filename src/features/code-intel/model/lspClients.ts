import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  LSPClient,
  languageServerExtensions,
  type Transport,
} from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { lspLanguageId, type LspServerId } from "./codeIntelSettings";

type Handler = (message: string) => void;

const handlers = new Map<string, Set<Handler>>();
const clients = new Map<string, Promise<LSPClient | null>>();
const sessionOf = new Map<string, string>();
let listening = false;

/** Intelephense's default stubs plus WordPress (functions, hooks, classes). */
const PHP_STUBS = [
  ...[
    "apache",
    "bcmath",
    "bz2",
    "calendar",
    "com_dotnet",
    "Core",
    "ctype",
    "curl",
    "date",
    "dba",
    "dom",
    "enchant",
    "exif",
    "fileinfo",
    "filter",
    "fpm",
    "ftp",
    "gd",
    "hash",
    "iconv",
    "imap",
    "intl",
    "json",
    "ldap",
    "libxml",
    "mbstring",
    "mcrypt",
    "mssql",
    "mysqli",
    "oci8",
    "odbc",
    "openssl",
    "pcntl",
    "pcre",
    "PDO",
    "pgsql",
    "Phar",
    "posix",
    "pspell",
    "random",
    "readline",
    "Reflection",
    "regex",
    "session",
    "shmop",
    "SimpleXML",
    "snmp",
    "soap",
    "sockets",
    "sodium",
    "SPL",
    "sqlite3",
    "standard",
    "superglobals",
    "sybase",
    "sysvmsg",
    "sysvsem",
    "sysvshm",
    "tidy",
    "tokenizer",
    "uri",
    "xml",
    "xmlreader",
    "xmlrpc",
    "xmlwriter",
    "Zend OPcache",
    "zip",
    "zlib",
  ],
  "wordpress",
];

/**
 * Answer the server→client requests the CodeMirror client doesn't handle.
 * Returns true when the message was a request we answered.
 */
function answerServerRequest(id: string, raw: string): boolean {
  if (!raw.includes('"method"')) return false;
  let msg: {
    id?: number | string;
    method?: string;
    params?: { items?: { section?: string }[] };
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return false;
  }
  if (msg.id === undefined || !msg.method) return false;
  let result: unknown;
  switch (msg.method) {
    case "workspace/configuration":
      result = (msg.params?.items ?? []).map((item) =>
        item.section === "intelephense"
          ? { stubs: PHP_STUBS, files: { maxSize: 5_000_000 } }
          : !item.section
            ? { intelephense: { stubs: PHP_STUBS } }
            : null,
      );
      break;
    case "client/registerCapability":
    case "client/unregisterCapability":
    case "window/workDoneProgress/create":
      result = null;
      break;
    default:
      return false;
  }
  void invoke("lsp_send", {
    id,
    message: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }),
  }).catch(() => {});
  return true;
}

function ensureListening() {
  if (listening) return;
  listening = true;
  try {
    listen<{ id: string; message: string }>("lsp-message", (e) => {
      if (answerServerRequest(e.payload.id, e.payload.message)) return;
      handlers.get(e.payload.id)?.forEach((h) => h(e.payload.message));
    }).catch(() => {});
    listen<string>("lsp-exit", (e) => {
      handlers.delete(e.payload);
      for (const [key, id] of sessionOf) {
        if (id === e.payload) {
          sessionOf.delete(key);
          clients.delete(key);
        }
      }
    }).catch(() => {});
  } catch {
    // no Tauri runtime (tests)
  }
}

export function fileUri(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const withRoot = /^[A-Za-z]:\//.test(slashed) ? `/${slashed}` : slashed;
  return `file://${withRoot.split("/").map(encodeURIComponent).join("/").replace(/%3A/g, ":")}`;
}

function transport(id: string): Transport {
  return {
    send(message) {
      void invoke("lsp_send", { id, message }).catch(() => {});
    },
    subscribe(handler) {
      let set = handlers.get(id);
      if (!set) handlers.set(id, (set = new Set()));
      set.add(handler);
    },
    unsubscribe(handler) {
      handlers.get(id)?.delete(handler);
    },
  };
}

/** Errors from starting servers, shown once per server and project. */
export type LspError = { server: LspServerId; root: string; message: string };
const errorListeners = new Set<(e: LspError) => void>();
export function onLspError(listener: (e: LspError) => void) {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

async function startClient(
  server: LspServerId,
  root: string,
): Promise<LSPClient | null> {
  ensureListening();
  try {
    const id = await invoke<string>("lsp_start", { server, root });
    sessionOf.set(`${server}|${root}`, id);
    const client = new LSPClient({
      rootUri: fileUri(root),
      timeout: 8000,
      extensions: [
        ...languageServerExtensions(),
        { clientCapabilities: { workspace: { configuration: true } } },
      ],
      initializationOptions:
        server === "php" ? { clearCache: false } : undefined,
    });
    client.connect(transport(id));
    return client;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorListeners.forEach((l) => l({ server, root, message }));
    return null;
  }
}

/** The editor extension connecting `path` to its language server, or null. */
export async function lspExtension(
  server: LspServerId,
  root: string,
  path: string,
): Promise<Extension | null> {
  const key = `${server}|${root}`;
  let pending = clients.get(key);
  if (!pending) {
    pending = startClient(server, root);
    clients.set(key, pending);
  }
  const client = await pending;
  if (!client) {
    clients.delete(key);
    return null;
  }
  return client.plugin(fileUri(path), lspLanguageId(path));
}

/** Stop every server (e.g. when language servers are switched off). */
export async function stopAllLsp() {
  const ids = [...sessionOf.values()];
  for (const [, pending] of clients) {
    const client = await pending;
    client?.disconnect();
  }
  clients.clear();
  sessionOf.clear();
  await Promise.all(
    ids.map((id) => invoke("lsp_stop", { id }).catch(() => {})),
  );
}
