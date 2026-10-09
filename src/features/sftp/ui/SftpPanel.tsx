import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  FilePlus,
  FolderPlus,
  GitBranch,
  Pencil,
  RefreshCw,
  Server,
  Settings,
  Square,
  Terminal,
  Trash2,
  Unlink,
} from "../../../shared/ui/icons";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../files/ui/ExplorerMenu";
import { FileTypeIcon } from "../../files/ui/FileTypeIcon";
import { SftpSetupDialog } from "./SftpSetupDialog";
import type { OpenFileFn } from "../../search/model/search";
import { gitDiffFiles } from "../../../platform/tauri/fs";
import {
  clearLogs,
  openDiff,
  openSshTerminal,
  reloadConfigs,
  report,
  sftpCancelAll,
  sftpDeleteRemote,
  sftpDisconnectAll,
  sftpDownloadRemote,
  sftpInitConfig,
  sftpList,
  sftpOpenRemote,
  sftpRemoteCreate,
  sftpRemoteRename,
  sftpSetProfile,
  sftpSync,
  sftpUpload,
  useSftpConfigs,
  useSftpState,
  type RemoteEntry,
  type SftpConfig,
} from "../model/sftp";

type Props = {
  cwd: string;
  onOpenFile: OpenFileFn;
};

type DirState = {
  entries: RemoteEntry[] | null;
  loading: boolean;
  error: string | null;
};
type Menu = { x: number; y: number; entry: RemoteEntry | null };
type Editing =
  | { kind: "new-file" | "new-folder"; parent: string }
  | { kind: "rename"; entry: RemoteEntry };

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function localFor(config: SftpConfig, remote: string): string | null {
  const base = config.remotePath.replace(/\/+$/, "");
  if (remote !== base && !remote.startsWith(`${base}/`)) return null;
  const rel = remote.slice(base.length).replace(/^\/+/, "");
  return rel ? `${config.context.replace(/\/+$/, "")}/${rel}` : config.context;
}

function ToolButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export function SftpPanel({ cwd, onOpenFile }: Props) {
  const data = useSftpConfigs(cwd);
  const [setupOpen, setSetupOpen] = useState(false);
  const setupDialog = setupOpen ? (
    <SftpSetupDialog
      workspace={cwd}
      projectName={cwd.split("/").filter(Boolean).pop() ?? cwd}
      onClose={() => setSetupOpen(false)}
    />
  ) : null;
  const configs = data?.configs ?? [];
  const [selected, setSelected] = useState(0);
  const config =
    configs.find((c) => c.index === selected) ?? configs[0] ?? null;

  useEffect(() => {
    if (configs.length && !configs.some((c) => c.index === selected)) {
      setSelected(configs[0]!.index);
    }
  }, [configs, selected]);

  const openConfigFile = async () => {
    const path = await report(sftpInitConfig(cwd));
    if (path) {
      onOpenFile(path, undefined, { exact: true, pin: true });
      reloadConfigs();
    }
  };

  if (!data) {
    return <p className="px-3 py-2 text-[12px] text-content/50">Loading…</p>;
  }

  if (!data.exists) {
    return (
      <div className="flex flex-col gap-3 px-3 py-4 text-[12px] text-content/60">
        <p>
          No SFTP config in this project. MonoCode uses{" "}
          <code className="text-content/80">.vscode/sftp.json</code> when it
          exists (the VS Code SFTP extension format); a new config is created at{" "}
          <code className="text-content/80">.monocode/sftp.json</code>.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="rounded-md bg-accent px-2.5 py-1 text-white hover:opacity-90"
          >
            Setup SFTP…
          </button>
          <button
            type="button"
            onClick={() => void openConfigFile()}
            className="rounded-md border border-content/10 px-2.5 py-1 text-content/80 hover:bg-content/8"
          >
            Create sftp.json in editor
          </button>
        </div>
        <OutputLog />
        {setupDialog}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data.error ? (
        <div className="flex flex-col gap-2 border-b border-stroke px-3 py-2 text-[12px] text-red-400">
          <span className="break-words">{data.error}</span>
          <button
            type="button"
            onClick={() => void openConfigFile()}
            className="self-start rounded-md border border-content/10 px-2 py-0.5 text-content/70 hover:bg-content/8"
          >
            Edit sftp.json
          </button>
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            className="self-start rounded-md border border-content/10 px-2 py-0.5 text-content/70 hover:bg-content/8"
          >
            Setup SFTP…
          </button>
        </div>
      ) : null}
      {config ? (
        <ConfigView
          key={`${cwd}:${config.index}:${config.activeProfile ?? ""}:${config.host}:${config.remotePath}`}
          cwd={cwd}
          config={config}
          configs={configs}
          onSelect={setSelected}
          onOpenFile={onOpenFile}
          onEditConfig={() => void openConfigFile()}
          onSetup={() => setSetupOpen(true)}
        />
      ) : null}
      <OutputLog />
      {setupDialog}
    </div>
  );
}

function ConfigView({
  cwd,
  config,
  configs,
  onSelect,
  onOpenFile,
  onEditConfig,
  onSetup,
}: {
  cwd: string;
  config: SftpConfig;
  configs: SftpConfig[];
  onSelect: (index: number) => void;
  onOpenFile: OpenFileFn;
  onEditConfig: () => void;
  onSetup: () => void;
}) {
  const status = useSftpState((s) => s.status);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([config.remotePath]),
  );
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const root = config.remotePath;
  const ws = cwd;

  const load = useCallback(
    async (dir: string) => {
      setDirs((prev) => ({
        ...prev,
        [dir]: {
          entries: prev[dir]?.entries ?? null,
          loading: true,
          error: null,
        },
      }));
      try {
        const res = await sftpList(ws, config.index, dir);
        setDirs((prev) => ({
          ...prev,
          [dir]: { entries: res.entries, loading: false, error: null },
        }));
      } catch (error) {
        setDirs((prev) => ({
          ...prev,
          [dir]: { entries: null, loading: false, error: String(error) },
        }));
      }
    },
    [ws, config.index],
  );

  const loaded = useRef(false);
  const connect = () => {
    loaded.current = true;
    void load(root);
  };

  const refreshAll = () => {
    for (const dir of expanded) void load(dir);
  };

  const toggle = (entry: RemoteEntry) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        if (!dirs[entry.path]?.entries) void load(entry.path);
      }
      return next;
    });
  };

  const openRemote = async (entry: RemoteEntry, temp: boolean) => {
    const local = await report(
      sftpOpenRemote(ws, config.index, entry.path, temp),
    );
    if (local) onOpenFile(local, undefined, { exact: true, pin: !temp });
  };

  const busy = status.running > 0;
  const run = (work: Promise<unknown>, refresh = true) => {
    void report(work).then(() => {
      if (refresh && loaded.current) refreshAll();
    });
  };

  const uploadChanged = async () => {
    const index = await report(gitDiffFiles(cwd));
    if (!index) return;
    const paths = index.files
      .filter(
        (f) => f.status !== "deleted" && f.path.startsWith(config.context),
      )
      .map((f) => f.path);
    if (!paths.length) return;
    run(sftpUpload(ws, paths));
  };

  const menuItems = (entry: RemoteEntry | null): ExplorerMenuItem[] => {
    if (!entry) {
      return [
        { kind: "item", id: "new-file", label: "New File" },
        { kind: "item", id: "new-folder", label: "New Folder" },
        { kind: "sep" },
        { kind: "item", id: "refresh", label: "Refresh" },
      ];
    }
    const isDir = entry.kind === "dir";
    const hasLocal = !!localFor(config, entry.path);
    return [
      ...(isDir
        ? []
        : [
            {
              kind: "item" as const,
              id: "open",
              label: "Open (temp copy, saves upload)",
            },
            {
              kind: "item" as const,
              id: "edit-local",
              label: "Edit in Local",
              disabled: !hasLocal,
            },
            {
              kind: "item" as const,
              id: "diff",
              label: "Diff with Local",
              disabled: !hasLocal,
            },
          ]),
      { kind: "item", id: "download", label: "Download", disabled: !hasLocal },
      {
        kind: "item",
        id: "download-force",
        label: "Force Download",
        disabled: !hasLocal,
      },
      ...(isDir
        ? [
            { kind: "sep" as const },
            { kind: "item" as const, id: "new-file", label: "New File" },
            { kind: "item" as const, id: "new-folder", label: "New Folder" },
          ]
        : []),
      { kind: "sep" },
      { kind: "item", id: "copy-path", label: "Copy Remote Path" },
      {
        kind: "item",
        id: "reveal-local",
        label: "Reveal Local File",
        disabled: !hasLocal,
      },
      { kind: "sep" },
      { kind: "item", id: "rename", label: "Rename" },
      { kind: "item", id: "delete", label: "Delete", danger: true },
    ];
  };

  const onMenuPick = async (id: string, entry: RemoteEntry | null) => {
    const dir = entry
      ? entry.kind === "dir"
        ? entry.path
        : parentOf(entry.path)
      : root;
    switch (id) {
      case "open":
        if (entry) await openRemote(entry, true);
        return;
      case "edit-local":
        if (entry) await openRemote(entry, false);
        return;
      case "diff": {
        const local = entry && localFor(config, entry.path);
        if (local) await openDiff(ws, local);
        return;
      }
      case "download":
      case "download-force":
        if (entry)
          run(
            sftpDownloadRemote(
              ws,
              config.index,
              [entry.path],
              id === "download-force",
            ),
            false,
          );
        return;
      case "new-file":
      case "new-folder":
        if (entry?.kind === "dir") {
          setExpanded((prev) => new Set(prev).add(entry.path));
          if (!dirs[entry.path]?.entries) void load(entry.path);
        }
        setEditing({ kind: id, parent: dir });
        return;
      case "refresh":
        refreshAll();
        return;
      case "copy-path":
        if (entry) await navigator.clipboard.writeText(entry.path);
        return;
      case "reveal-local": {
        const local = entry && localFor(config, entry.path);
        if (local && entry?.kind !== "dir")
          onOpenFile(local, undefined, { exact: true });
        return;
      }
      case "rename":
        if (entry) setEditing({ kind: "rename", entry });
        return;
      case "delete": {
        if (!entry) return;
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const ok = await ask(
          `Delete ${entry.path} on ${config.host}? This cannot be undone.`,
          {
            title: "Delete remote",
            kind: "warning",
          },
        );
        if (!ok) return;
        await report(
          sftpDeleteRemote(ws, {
            index: config.index,
            remotePaths: [entry.path],
          }),
        );
        void load(parentOf(entry.path));
        return;
      }
    }
  };

  const commitEdit = async (value: string) => {
    const edit = editing;
    setEditing(null);
    const name = value.trim();
    if (!edit || !name || name.includes("/")) return;
    if (edit.kind === "rename") {
      const to = joinRemote(parentOf(edit.entry.path), name);
      if (to !== edit.entry.path)
        await report(sftpRemoteRename(ws, config.index, edit.entry.path, to));
      void load(parentOf(edit.entry.path));
    } else {
      await report(
        sftpRemoteCreate(
          ws,
          config.index,
          joinRemote(edit.parent, name),
          edit.kind === "new-folder",
        ),
      );
      void load(edit.parent);
    }
  };

  const renderDir = (dir: string, depth: number): ReactNode => {
    const state = dirs[dir];
    const creating =
      editing && editing.kind !== "rename" && editing.parent === dir
        ? editing
        : null;
    return (
      <>
        {creating ? (
          <InlineName
            depth={depth}
            isDir={creating.kind === "new-folder"}
            initial=""
            onDone={(v) => void commitEdit(v)}
          />
        ) : null}
        {state?.error ? (
          <p
            style={{ paddingLeft: 8 + depth * 12 }}
            className="py-1 pr-2 text-[12px] break-words text-red-400"
          >
            {state.error}
          </p>
        ) : null}
        {state?.loading && !state.entries ? (
          <p
            style={{ paddingLeft: 8 + depth * 12 }}
            className="py-1 text-[12px] text-content/45"
          >
            Loading…
          </p>
        ) : null}
        {state?.entries?.map((entry) => {
          const isDir = entry.kind === "dir";
          const open = expanded.has(entry.path);
          if (editing?.kind === "rename" && editing.entry.path === entry.path) {
            return (
              <InlineName
                key={entry.path}
                depth={depth}
                isDir={isDir}
                initial={entry.name}
                onDone={(v) => void commitEdit(v)}
              />
            );
          }
          return (
            <div key={entry.path}>
              <button
                type="button"
                title={entry.path}
                onClick={() => {
                  setSelectedPath(entry.path);
                  if (isDir) toggle(entry);
                }}
                onDoubleClick={() => {
                  if (!isDir) void openRemote(entry, true);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedPath(entry.path);
                  setMenu({ x: e.clientX, y: e.clientY, entry });
                }}
                style={{ paddingLeft: 8 + depth * 12 }}
                className={`flex h-7 w-full cursor-default items-center gap-1 pr-2 text-left text-[13px] leading-none outline-none ${
                  selectedPath === entry.path
                    ? "bg-selection text-content"
                    : "text-content hover:bg-content/5"
                }`}
              >
                <span className="grid size-4 shrink-0 place-items-center text-content/50">
                  {isDir ? (
                    open ? (
                      <ChevronDown className="size-3.5" strokeWidth={1.75} />
                    ) : (
                      <ChevronRight className="size-3.5" strokeWidth={1.75} />
                    )
                  ) : null}
                </span>
                <span className="shrink-0">
                  <FileTypeIcon name={entry.name} isDir={isDir} isOpen={open} />
                </span>
                <span
                  className={`min-w-0 truncate ${entry.kind === "symlink" ? "italic text-content/60" : ""}`}
                >
                  {entry.name}
                </span>
              </button>
              {isDir && open ? renderDir(entry.path, depth + 1) : null}
            </div>
          );
        })}
      </>
    );
  };

  const target = `${config.protocol}://${config.username ? `${config.username}@` : ""}${config.host}${
    config.port && config.port !== (config.protocol === "ftp" ? 21 : 22)
      ? `:${config.port}`
      : ""
  }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-stroke px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Server
            className="size-3.5 shrink-0 text-content/50"
            strokeWidth={1.75}
          />
          {configs.length > 1 ? (
            <select
              value={config.index}
              onChange={(e) => onSelect(Number(e.target.value))}
              className="min-w-0 flex-1 truncate rounded bg-transparent text-[13px] text-content outline-none"
            >
              {configs.map((c) => (
                <option key={c.index} value={c.index}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] text-content">
              {config.name}
            </span>
          )}
          <ToolButton label="Setup SFTP…" onClick={onSetup}>
            <Settings className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
          <ToolButton label="Edit sftp.json" onClick={onEditConfig}>
            <Pencil className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
        </div>
        <div
          className="truncate text-[11px] text-content/45"
          title={`${target}${config.remotePath}`}
        >
          {target}
          {config.remotePath}
          {config.hops
            ? ` · ${config.hops} hop${config.hops > 1 ? "s" : ""}`
            : ""}
        </div>
        {config.profiles.length ? (
          <label className="flex items-center gap-2 text-[12px] text-content/60">
            Profile
            <select
              value={config.activeProfile ?? ""}
              onChange={(e) => {
                const value = e.target.value || null;
                void sftpSetProfile(ws, config.index, value).then(() => {
                  void sftpDisconnectAll();
                  reloadConfigs();
                });
              }}
              className="min-w-0 flex-1 rounded border border-content/10 bg-transparent px-1 py-0.5 text-content outline-none"
            >
              <option value="">(none)</option>
              {config.profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex flex-wrap items-center gap-0.5">
          <ToolButton
            label="Upload project"
            onClick={() => run(sftpUpload(ws, [config.context]))}
          >
            <CloudUpload className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
          <ToolButton
            label="Download project"
            onClick={() =>
              run(
                sftpDownloadRemote(ws, config.index, [config.remotePath]),
                false,
              )
            }
          >
            <CloudDownload className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
          <ToolButton
            label="Sync local → remote"
            onClick={() =>
              run(sftpSync(ws, "localToRemote", { index: config.index }))
            }
          >
            <span className="text-[10px] font-medium">L→R</span>
          </ToolButton>
          <ToolButton
            label="Sync remote → local"
            onClick={() =>
              run(sftpSync(ws, "remoteToLocal", { index: config.index }), false)
            }
          >
            <span className="text-[10px] font-medium">R→L</span>
          </ToolButton>
          <ToolButton
            label="Sync both directions"
            onClick={() => run(sftpSync(ws, "both", { index: config.index }))}
          >
            <ArrowLeftRight className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
          <ToolButton
            label="Upload changed files (git)"
            onClick={() => void uploadChanged()}
          >
            <GitBranch className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
          {config.protocol === "sftp" ? (
            <ToolButton
              label="Open SSH in Terminal"
              onClick={() =>
                void openSshTerminal(ws, config.index, config.context)
              }
            >
              <Terminal className="size-3.5" strokeWidth={1.75} />
            </ToolButton>
          ) : null}
          <ToolButton
            label="Cancel all transfers"
            disabled={!busy}
            onClick={() => void sftpCancelAll()}
          >
            <Square className="size-3" strokeWidth={1.75} />
          </ToolButton>
          <ToolButton
            label="Disconnect"
            onClick={() => {
              void sftpDisconnectAll();
              loaded.current = false;
              setDirs({});
            }}
          >
            <Unlink className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
        </div>
        <div className="flex flex-wrap gap-x-3 text-[11px] text-content/45">
          <span>Upload on save: {config.uploadOnSave ? "on" : "off"}</span>
          {config.watcher ? (
            <span>
              Watcher: {config.watcher.files.join(", ")}
              {config.watcher.autoUpload ? " ↑" : ""}
              {config.watcher.autoDelete ? " ✕" : ""}
            </span>
          ) : null}
        </div>
        {busy || status.total ? (
          <div className="text-[11px] text-content/60">
            {busy ? "⟳ " : "✓ "}
            {status.label}
            {status.total ? ` (${status.done}/${status.total})` : ""}
          </div>
        ) : null}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate pl-1 text-[11px] font-medium uppercase tracking-wide text-content/45">
          Remote Explorer
        </span>
        <ToolButton
          label="New file"
          disabled={!dirs[root]}
          onClick={() => setEditing({ kind: "new-file", parent: root })}
        >
          <FilePlus className="size-3.5" strokeWidth={1.75} />
        </ToolButton>
        <ToolButton
          label="New folder"
          disabled={!dirs[root]}
          onClick={() => setEditing({ kind: "new-folder", parent: root })}
        >
          <FolderPlus className="size-3.5" strokeWidth={1.75} />
        </ToolButton>
        <ToolButton
          label={dirs[root] ? "Refresh" : "Connect"}
          onClick={() => (dirs[root] ? refreshAll() : connect())}
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </ToolButton>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-2"
        onContextMenu={(e) => {
          if (!dirs[root]) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {dirs[root] ? (
          renderDir(root, 0)
        ) : (
          <div className="px-3 py-2">
            <button
              type="button"
              onClick={connect}
              className="rounded-md border border-content/10 px-2.5 py-1 text-[12px] text-content/80 hover:bg-content/8"
            >
              Connect and browse {config.remotePath}
            </button>
          </div>
        )}
      </div>
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.entry)}
          ariaLabel="Remote file actions"
          onPick={(id) => {
            const entry = menu.entry;
            setMenu(null);
            void onMenuPick(id, entry);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function InlineName({
  depth,
  isDir,
  initial,
  onDone,
}: {
  depth: number;
  isDir: boolean;
  initial: string;
  onDone: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <div
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex h-7 items-center gap-1 bg-content/10 pr-2"
    >
      <span className="grid size-4 shrink-0" />
      <FileTypeIcon name={value || "file"} isDir={isDir} />
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(value);
          if (e.key === "Escape") finish("");
        }}
        onBlur={() => finish(value)}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none"
      />
    </div>
  );
}

function OutputLog() {
  const logs = useSftpState((s) => s.logs);
  const [open, setOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const errors = useMemo(
    () => logs.filter((l) => l.level === "error").length,
    [logs],
  );
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open, logs.length]);
  return (
    <div
      className={`flex shrink-0 flex-col border-t border-stroke ${open ? "h-48" : ""}`}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wide text-content/45 hover:text-content/70"
        >
          {open ? (
            <ChevronDown className="size-3" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="size-3" strokeWidth={1.75} />
          )}
          Output
          {errors ? (
            <span className="text-red-400 normal-case">
              · {errors} error{errors > 1 ? "s" : ""}
            </span>
          ) : null}
        </button>
        {open ? (
          <ToolButton label="Clear output" onClick={clearLogs}>
            <Trash2 className="size-3.5" strokeWidth={1.75} />
          </ToolButton>
        ) : null}
      </div>
      {open ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 font-mono text-[11px] leading-relaxed select-text">
          {logs.length === 0 ? (
            <p className="text-content/40">No output yet.</p>
          ) : null}
          {logs.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words ${line.level === "error" ? "text-red-400" : "text-content/65"}`}
            >
              <span className="text-content/30">
                {new Date(line.time).toLocaleTimeString()}{" "}
              </span>
              {line.message}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : null}
    </div>
  );
}
