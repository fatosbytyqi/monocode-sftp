import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  OPEN_TERMINAL_COMMAND_EVENT,
  type OpenTerminalCommandDetail,
} from "../../terminal/model/startupCommand";
import { isRemoteProjectPath } from "../../projects/model/recents";

export type Protocol = "sftp" | "ftp" | "local";
export type DownloadOnOpen = "off" | "on" | "confirm";
export type Direction = "localToRemote" | "remoteToLocal" | "both";

export type SftpConfig = {
  index: number;
  name: string;
  context: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  uploadOnSave: boolean;
  downloadOnOpen: DownloadOnOpen;
  watcher: { files: string[]; autoUpload: boolean; autoDelete: boolean } | null;
  profiles: string[];
  activeProfile: string | null;
  filesExclude: string[];
  order: number;
  hops: number;
};

export type ConfigsResponse = {
  configPath: string;
  exists: boolean;
  configs: SftpConfig[];
  error: string | null;
};

export type RemoteEntry = {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type Summary = {
  uploaded: number;
  downloaded: number;
  deleted: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  errors: string[];
};

export type LogLine = {
  level: "info" | "error";
  message: string;
  time: number;
};
export type Status = {
  running: number;
  label: string;
  done: number;
  total: number;
};
export type PromptRequest = {
  id: string;
  title: string;
  message: string;
  secret: boolean;
  confirm: boolean;
};
export type DiffView = {
  path: string;
  remotePath: string;
  local: string;
  remote: string | null;
  binary: boolean;
};

// ------------------------------------------------------------------ commands

export const sftpConfigs = (workspace: string) =>
  invoke<ConfigsResponse>("sftp_configs", { workspace });
export const sftpInitConfig = (workspace: string) =>
  invoke<string>("sftp_init_config", { workspace });
export const sftpSetProfile = (
  workspace: string,
  index: number,
  profile: string | null,
) => invoke<void>("sftp_set_profile", { workspace, index, profile });
export const sftpUpload = (
  workspace: string,
  paths: string[],
  opts: { force?: boolean; allProfiles?: boolean } = {},
) => invoke<Summary>("sftp_upload", { workspace, paths, ...opts });
export const sftpDownload = (
  workspace: string,
  paths: string[],
  force = false,
) => invoke<Summary>("sftp_download", { workspace, paths, force });
export const sftpDownloadRemote = (
  workspace: string,
  index: number,
  remotePaths: string[],
  force = false,
) =>
  invoke<Summary>("sftp_download_remote", {
    workspace,
    index,
    remotePaths,
    force,
  });
export const sftpSync = (
  workspace: string,
  direction: Direction,
  target: { path: string } | { index: number },
) => invoke<Summary>("sftp_sync", { workspace, direction, ...target });
export const sftpList = (
  workspace: string,
  index: number,
  remotePath?: string,
) =>
  invoke<{ path: string; entries: RemoteEntry[] }>("sftp_list", {
    workspace,
    index,
    remotePath,
  });
export const sftpDeleteRemote = (
  workspace: string,
  target: { index: number; remotePaths: string[] } | { localPaths: string[] },
) => invoke<Summary>("sftp_delete_remote", { workspace, ...target });
export const sftpRemoteCreate = (
  workspace: string,
  index: number,
  remotePath: string,
  dir: boolean,
) => invoke<void>("sftp_remote_create", { workspace, index, remotePath, dir });
export const sftpRemoteRename = (
  workspace: string,
  index: number,
  from: string,
  to: string,
) => invoke<void>("sftp_remote_rename", { workspace, index, from, to });
export const sftpOpenRemote = (
  workspace: string,
  index: number,
  remotePath: string,
  temp: boolean,
) => invoke<string>("sftp_open_remote", { workspace, index, remotePath, temp });
export const sftpOnSave = (path: string) =>
  invoke<Summary | null>("sftp_on_save", { path });
export const sftpOnOpen = (path: string) =>
  invoke<DownloadOnOpen>("sftp_on_open", { path });
export const sftpWorkspaceOf = (path: string) =>
  invoke<string | null>("sftp_workspace_of", { path });
export const sftpCancelAll = () => invoke<void>("sftp_cancel_all");
export const sftpDisconnectAll = () => invoke<void>("sftp_disconnect_all");
export const sftpSshCommand = (workspace: string, index: number) =>
  invoke<string>("sftp_ssh_command", { workspace, index });
export const sftpPromptReply = (id: string, value: string | null) =>
  invoke<void>("sftp_prompt_reply", { id, value });

// ------------------------------------------------------------------- store

type State = {
  logs: LogLine[];
  status: Status;
  prompts: PromptRequest[];
  diff: DiffView | null;
  /** Bumped when sftp.json changes so panels reload. */
  configVersion: number;
  lastError: string | null;
};

const MAX_LOGS = 1000;

let state: State = {
  logs: [],
  status: { running: 0, label: "", done: 0, total: 0 },
  prompts: [],
  diff: null,
  configVersion: 0,
  lastError: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  ensureListening();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSftpState<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  // Outside the desktop shell (tests, browser previews) there is no event bus.
  const on = <T>(event: string, handler: (payload: T) => void) => {
    try {
      listen<T>(event, (e) => handler(e.payload)).catch(() => {});
    } catch {
      // no Tauri runtime
    }
  };
  on<LogLine>("sftp-log", (line) => {
    const logs =
      state.logs.length >= MAX_LOGS
        ? state.logs.slice(-MAX_LOGS + 1)
        : state.logs;
    set({
      logs: [...logs, line],
      ...(line.level === "error" ? { lastError: line.message } : {}),
    });
  });
  on<Status>("sftp-status", (status) => set({ status }));
  on<PromptRequest>("sftp-prompt", (prompt) =>
    set({ prompts: [...state.prompts, prompt] }),
  );
  on<string>("sftp-config-changed", () =>
    set({ configVersion: state.configVersion + 1 }),
  );
}

export function answerPrompt(id: string, value: string | null) {
  set({ prompts: state.prompts.filter((p) => p.id !== id) });
  void sftpPromptReply(id, value);
}

export function clearLogs() {
  set({ logs: [], lastError: null });
}

export function dismissError() {
  set({ lastError: null });
}

export function reloadConfigs() {
  set({ configVersion: state.configVersion + 1 });
}

function localLog(level: LogLine["level"], message: string) {
  set({
    logs: [...state.logs, { level, message, time: Date.now() }].slice(
      -MAX_LOGS,
    ),
    ...(level === "error" ? { lastError: message } : {}),
  });
}

/** Run a command and surface its failure in the output log and the error toast. */
export async function report<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    const result = await work;
    const summary = result as Partial<Summary> | null | undefined;
    if (
      summary &&
      typeof summary === "object" &&
      Array.isArray(summary.errors)
    ) {
      const first = summary.errors[0];
      if (summary.failed && first) {
        set({
          lastError:
            summary.failed > 1
              ? `${first} (+${summary.failed - 1} more)`
              : first,
        });
      }
    }
    return result;
  } catch (error) {
    localLog("error", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

// ---------------------------------------------------------------- hooks

export function sftpSupported(workspace: string | undefined | null): boolean {
  return !!workspace && workspace !== "~" && !isRemoteProjectPath(workspace);
}

export function useSftpConfigs(workspace: string | undefined | null) {
  const version = useSftpState((s) => s.configVersion);
  const [data, setData] = useState<ConfigsResponse | null>(null);
  useEffect(() => {
    if (!workspace || !sftpSupported(workspace)) {
      setData(null);
      return;
    }
    let cancelled = false;
    sftpConfigs(workspace).then(
      (next) => {
        if (!cancelled) setData(next);
      },
      (error) => {
        if (!cancelled)
          setData({
            configPath: "",
            exists: false,
            configs: [],
            error: String(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspace, version]);
  return data;
}

// --------------------------------------------------------------- actions

export async function openDiff(workspace: string, path: string) {
  const result = await report(
    invoke<Omit<DiffView, "path">>("sftp_diff", { workspace, path }),
  );
  if (result) set({ diff: { ...result, path } });
}

export function closeDiff() {
  set({ diff: null });
}

export async function openSshTerminal(
  workspace: string,
  index: number,
  cwd: string,
) {
  const command = await report(sftpSshCommand(workspace, index));
  if (!command) return;
  window.dispatchEvent(
    new CustomEvent<OpenTerminalCommandDetail>(OPEN_TERMINAL_COMMAND_EVENT, {
      detail: { cwd, command, title: "SSH" },
    }),
  );
}

/** Explorer context-menu entries (ids are prefixed `sftp:`). */
export const SFTP_EXPLORER_ACTIONS = [
  { id: "sftp:upload", label: "Upload" },
  { id: "sftp:download", label: "Download" },
  { id: "sftp:diff", label: "Diff with Remote", fileOnly: true },
  { id: "sftp:sync-l2r", label: "Sync Local → Remote", dirOnly: true },
  { id: "sftp:sync-r2l", label: "Sync Remote → Local", dirOnly: true },
  { id: "sftp:sync-both", label: "Sync Both Directions", dirOnly: true },
  { id: "sftp:upload-force", label: "Force Upload (ignore rules off)" },
  { id: "sftp:download-force", label: "Force Download (ignore rules off)" },
  { id: "sftp:upload-all", label: "Upload to All Profiles" },
  { id: "sftp:delete-remote", label: "Delete Remote", danger: true },
] as const;

export async function runExplorerAction(
  id: string,
  workspace: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  switch (id) {
    case "sftp:upload":
      await report(sftpUpload(workspace, [path]));
      return;
    case "sftp:upload-force":
      await report(sftpUpload(workspace, [path], { force: true }));
      return;
    case "sftp:upload-all":
      await report(sftpUpload(workspace, [path], { allProfiles: true }));
      return;
    case "sftp:download":
      await report(sftpDownload(workspace, [path]));
      return;
    case "sftp:download-force":
      await report(sftpDownload(workspace, [path], true));
      return;
    case "sftp:diff":
      if (!isDir) await openDiff(workspace, path);
      return;
    case "sftp:sync-l2r":
      await report(sftpSync(workspace, "localToRemote", { path }));
      return;
    case "sftp:sync-r2l":
      await report(sftpSync(workspace, "remoteToLocal", { path }));
      return;
    case "sftp:sync-both":
      await report(sftpSync(workspace, "both", { path }));
      return;
    case "sftp:delete-remote": {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const ok = await ask(
        `Delete the remote copy of ${path}? This cannot be undone.`,
        {
          title: "Delete remote",
          kind: "warning",
        },
      );
      if (ok) await report(sftpDeleteRemote(workspace, { localPaths: [path] }));
      return;
    }
  }
}
