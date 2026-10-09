import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Group,
  Row,
  Segmented,
  Select,
  Toggle,
} from "../../settings/ui/SettingsView";
import {
  updateCodeIntel,
  useCodeIntel,
  type LspServerId,
} from "../model/codeIntelSettings";
import { stopAllLsp } from "../model/lspClients";
import {
  completionProviderReady,
  resolveCompletionProvider,
  stopWarmCompletions,
} from "../model/aiComplete";
import {
  canRunHarnessTextPrompt,
  getHarnessAvailabilitySnapshot,
  subscribeHarnessAvailability,
} from "../../../integrations/harness";
import { modelsFor } from "../../sessions/model/models";
import {
  HARNESSES,
  HARNESS_TITLE,
  type HarnessId,
} from "../../sessions/model/session";

type ToolStatus = {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
};
type ToolsStatus = {
  node: string | null;
  nodeVersion: string | null;
  npm: boolean;
  dir: string;
  tools: ToolStatus[];
};

const SERVERS: { id: LspServerId; label: string; description: string }[] = [
  {
    id: "php",
    label: "PHP",
    description:
      "Intelephense: PHP and WordPress functions, parameter hints, go to definition, real errors.",
  },
  {
    id: "typescript",
    label: "JavaScript / TypeScript",
    description:
      "The TypeScript language server, for .js, .jsx, .ts and .tsx files.",
  },
  {
    id: "css",
    label: "CSS / SCSS / Less",
    description: "Properties, values, selectors and errors.",
  },
  {
    id: "html",
    label: "HTML",
    description: "Tags, attributes and embedded CSS/JS.",
  },
  {
    id: "json",
    label: "JSON",
    description: "Validation, including package.json and other known schemas.",
  },
];

/** Re-render when installed providers are detected. */
function useAvailability(): number {
  return useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
}

function providerOptions() {
  return [
    { value: "auto", label: "Auto (first installed agent)" },
    ...HARNESSES.map((id) => ({
      value: id,
      label: completionProviderReady(id)
        ? `${HARNESS_TITLE[id]}${canRunHarnessTextPrompt(id) ? "" : " (slower)"}`
        : `${HARNESS_TITLE[id]} (not installed)`,
    })),
  ];
}

function modelOptions(provider: HarnessId | null) {
  const models = provider ? modelsFor(provider) : [];
  return [
    {
      value: "auto",
      label: models[0] ? `Default (${models[0].name})` : "Default",
    },
    ...models.map((m) => ({
      value: m.id,
      label: m.provider ? `${m.name} · ${m.provider.name}` : m.name,
    })),
  ];
}

function SmallButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded-md border border-content/10 px-2.5 py-1 text-[12px] disabled:opacity-40 ${
        danger
          ? "text-red-400 hover:bg-red-400/10"
          : "text-content/75 hover:bg-content/8"
      }`}
    >
      {children}
    </button>
  );
}

function useTools() {
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [installing, setInstalling] = useState<string[] | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const refresh = useCallback(() => {
    invoke<ToolsStatus>("code_tools_status").then(setStatus, () =>
      setStatus(null),
    );
  }, []);
  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    try {
      listen<string>("code-tools-log", (e) =>
        setLog((l) => [...l.slice(-30), e.payload]),
      ).then(
        (u) => (unlisten = u),
        () => {},
      );
    } catch {
      // no Tauri runtime
    }
    return () => unlisten?.();
  }, [refresh]);
  const install = async (ids: string[]) => {
    setInstalling(ids);
    setLog([]);
    try {
      await invoke("code_tools_install", { ids });
    } catch (e) {
      setLog((l) => [...l, String(e)]);
    } finally {
      setInstalling(null);
      refresh();
    }
  };
  return { status, installing, log, install };
}

export function CodeEditorSettingsPage() {
  const settings = useCodeIntel();
  useAvailability();
  const resolvedProvider = resolveCompletionProvider(settings.ai.provider);
  const tools = useTools();
  const [outDir, setOutDir] = useState(settings.compile.outDir);
  const outDirTimer = useRef(0);

  const tool = (id: string) => tools.status?.tools.find((t) => t.id === id);
  const missingServers = SERVERS.filter(
    (s) => settings.lsp[s.id] && !tool(s.id)?.installed,
  ).map((s) => s.id);
  const nodeOk = !!tools.status?.node && tools.status.npm;
  const busy = tools.installing !== null;

  const installButton = (ids: string[], label = "Install") =>
    nodeOk ? (
      <SmallButton disabled={busy} onClick={() => void tools.install(ids)}>
        {busy && tools.installing?.some((i) => ids.includes(i))
          ? "Installing…"
          : label}
      </SmallButton>
    ) : null;

  const statusText = (id: string) => {
    const t = tool(id);
    if (!tools.status) return "Checking…";
    return t?.installed ? `Installed ${t.version ?? ""}` : "Not installed";
  };

  return (
    <div className="flex flex-col">
      <Group
        id="code-suggestions"
        title="Suggestions"
        description="Lightweight completions that work in every file, with nothing to install."
      >
        <Row
          label="Word completion"
          description="Suggest words that already appear in the open file."
        >
          <Toggle
            label="Word completion"
            on={settings.wordCompletion}
            onChange={(v) =>
              updateCodeIntel((s) => ({ ...s, wordCompletion: v }))
            }
          />
        </Row>
        <Row
          label="Snippets"
          description="Ready-made blocks for PHP and WordPress (add_action, WP_Query loop, enqueue…), JavaScript, CSS/SCSS/Less and HTML. Type the name, then press Enter."
        >
          <Toggle
            label="Snippets"
            on={settings.snippets}
            onChange={(v) => updateCodeIntel((s) => ({ ...s, snippets: v }))}
          />
        </Row>
      </Group>

      <Group
        id="language-servers"
        title="Language servers"
        description="The engines behind VS Code's IntelliSense: suggestions from your whole project, parameter hints, hover docs, go to definition (F12) and real error checking. They run on this computer and need Node.js."
        action={
          missingServers.length && settings.lsp.enabled
            ? installButton(missingServers, "Install missing")
            : null
        }
      >
        <Row
          label="Use language servers"
          description={
            tools.status
              ? tools.status.node
                ? `Node.js ${tools.status.nodeVersion ?? ""} found.${tools.status.npm ? "" : " npm was not found."}`
                : "Node.js was not found. Install it from nodejs.org, then reopen this page."
              : "Checking for Node.js…"
          }
        >
          <Toggle
            label="Use language servers"
            on={settings.lsp.enabled}
            onChange={(v) => {
              updateCodeIntel((s) => ({ ...s, lsp: { ...s.lsp, enabled: v } }));
              if (!v) void stopAllLsp();
            }}
          />
        </Row>
        {SERVERS.map((server) => (
          <Row
            key={server.id}
            label={server.label}
            description={`${server.description} ${statusText(server.id)}.`}
          >
            {!tool(server.id)?.installed ? installButton([server.id]) : null}
            <Toggle
              label={server.label}
              disabled={!settings.lsp.enabled}
              on={settings.lsp[server.id]}
              onChange={(v) => {
                updateCodeIntel((s) => ({
                  ...s,
                  lsp: { ...s.lsp, [server.id]: v },
                }));
                if (!v) void stopAllLsp();
              }}
            />
          </Row>
        ))}
        {tools.log.length ? (
          <div className="max-h-40 overflow-y-auto border-t border-content/5 px-4 py-2 font-mono text-[11px] leading-relaxed text-content/55 select-text">
            {tools.log.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
          </div>
        ) : null}
      </Group>

      <Group
        id="ai-suggestions"
        title="AI suggestions"
        description="Grey inline suggestions while you type. Tab accepts, Esc dismisses. Uses any agent you have installed (Claude Code, Codex, Cursor, Antigravity, …) through its own sign-in, the same way MonoCode writes session titles and answers side questions. No API key needed; suggestions count toward that agent's plan usage."
      >
        <Row label="AI inline suggestions">
          <Toggle
            label="AI inline suggestions"
            on={settings.ai.enabled}
            onChange={(v) => {
              updateCodeIntel((s) => ({ ...s, ai: { ...s.ai, enabled: v } }));
              if (!v) stopWarmCompletions();
            }}
          />
        </Row>
        <Row
          label="Provider"
          description={
            resolvedProvider
              ? `Suggestions come from ${HARNESS_TITLE[resolvedProvider]}${
                  canRunHarnessTextPrompt(resolvedProvider)
                    ? "."
                    : ", through a hidden one-off session, which is slower."
                }`
              : "No installed agent found. Install and sign in to one in Settings → Providers."
          }
        >
          <Select
            label="Provider"
            value={settings.ai.provider}
            options={providerOptions()}
            onChange={(provider) => {
              stopWarmCompletions();
              updateCodeIntel((s) => ({
                ...s,
                ai: { ...s.ai, provider, model: "auto" },
              }));
            }}
          />
        </Row>
        <Row
          label="Model"
          description="Smaller, faster models suit typing suggestions best (Haiku, mini, flash…)."
        >
          <Select
            label="Model"
            value={settings.ai.model}
            options={modelOptions(resolvedProvider)}
            onChange={(model) =>
              updateCodeIntel((s) => ({ ...s, ai: { ...s.ai, model } }))
            }
          />
        </Row>
        <Row
          label="Wait after typing"
          description="How long to pause before a suggestion is requested. Longer waits mean fewer requests."
        >
          <Segmented
            label="Wait after typing"
            value={String(settings.ai.debounceMs)}
            options={[
              { value: "400", label: "Short" },
              { value: "700", label: "Normal" },
              { value: "1200", label: "Long" },
            ]}
            onChange={(v) =>
              updateCodeIntel((s) => ({
                ...s,
                ai: { ...s.ai, debounceMs: Number(v) },
              }))
            }
          />
        </Row>
      </Group>

      <Group
        id="style-compile"
        title="Compile SCSS / Less on save"
        description='Saving a .scss or .less file writes the .css next to it (or to the folder below). Saving a partial (_name.scss) recompiles the files that import it. A first-line comment overrides this per file, e.g. "// out: ../css/style.css, compress: true" or "// main: ../style.less".'
      >
        <Row
          label="SCSS / Sass"
          description="Built in, nothing to install. Source maps are not available for SCSS yet."
        >
          <Toggle
            label="Compile SCSS"
            on={settings.compile.scss}
            onChange={(v) =>
              updateCodeIntel((s) => ({
                ...s,
                compile: { ...s.compile, scss: v },
              }))
            }
          />
        </Row>
        <Row
          label="Less"
          description={`Uses the official Less compiler. ${statusText("less")}.`}
        >
          {!tool("less")?.installed ? installButton(["less"]) : null}
          <Toggle
            label="Compile Less"
            on={settings.compile.less}
            onChange={(v) =>
              updateCodeIntel((s) => ({
                ...s,
                compile: { ...s.compile, less: v },
              }))
            }
          />
        </Row>
        <Row
          label="Output"
          description="Compressed removes whitespace for production."
        >
          <Segmented
            label="Output style"
            value={settings.compile.style}
            options={[
              { value: "expanded", label: "Readable" },
              { value: "compressed", label: "Compressed" },
            ]}
            onChange={(style) =>
              updateCodeIntel((s) => ({
                ...s,
                compile: { ...s.compile, style },
              }))
            }
          />
        </Row>
        <Row
          label="Source maps"
          description="Write a .css.map so browser dev tools show your Less line numbers."
        >
          <Toggle
            label="Source maps"
            on={settings.compile.sourceMap}
            onChange={(v) =>
              updateCodeIntel((s) => ({
                ...s,
                compile: { ...s.compile, sourceMap: v },
              }))
            }
          />
        </Row>
        <Row
          label="Output folder"
          description="Relative to each source file, e.g. ../css. Empty writes the .css next to the source."
        >
          <input
            value={outDir}
            placeholder="next to the source"
            spellCheck={false}
            onChange={(e) => {
              const value = e.target.value;
              setOutDir(value);
              window.clearTimeout(outDirTimer.current);
              outDirTimer.current = window.setTimeout(
                () =>
                  updateCodeIntel((s) => ({
                    ...s,
                    compile: { ...s.compile, outDir: value.trim() },
                  })),
                400,
              );
            }}
            className="w-48 rounded-md border border-content/12 bg-transparent px-2 py-1 font-mono text-[12px] text-content outline-none focus:border-accent"
          />
        </Row>
        <Row
          label="Upload compiled CSS"
          description="When the project's SFTP config uploads on save, upload the compiled .css (and .map) too."
        >
          <Toggle
            label="Upload compiled CSS"
            on={settings.compile.uploadAfterCompile}
            onChange={(v) =>
              updateCodeIntel((s) => ({
                ...s,
                compile: { ...s.compile, uploadAfterCompile: v },
              }))
            }
          />
        </Row>
      </Group>
    </div>
  );
}
