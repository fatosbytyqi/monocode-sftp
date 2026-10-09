import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { listProjectFiles } from "../../../platform/tauri/fs";
import { X } from "../../../shared/ui/icons";
import {
  buildWatchFiles,
  EXTENSION_PRESETS,
  generatedGlob,
  normalizeExtension,
  normalizeFolder,
  parseWatchFiles,
  projectSuggestions,
  selectionMatches,
  type WatchSelection,
} from "../model/watchGlobs";

type Watcher = { files?: unknown; autoUpload?: unknown; autoDelete?: unknown };

type Props = {
  workspace: string;
  /** `context` from the config, relative to the workspace. */
  context: string;
  watcher: Watcher | null;
  onChange: (watcher: Watcher | undefined) => void;
};

function useProjectFiles(workspace: string, context: string) {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const prefix = context.replace(/^\.?\/*/, "").replace(/\/+$/, "");
    listProjectFiles(workspace).then(
      (all) => {
        if (cancelled) return;
        const rel = all
          .filter((f) => !f.isDir)
          .map((f) => f.relative.replace(/\\/g, "/"))
          .filter((r) => !prefix || r.startsWith(`${prefix}/`))
          .map((r) => (prefix ? r.slice(prefix.length + 1) : r));
        setFiles(rel);
      },
      () => !cancelled && setFiles([]),
    );
    return () => {
      cancelled = true;
    };
  }, [workspace, context]);
  return files;
}

function TagInput({
  tags,
  onChange,
  placeholder,
  suggestions,
  normalize,
  display = (t) => t,
  mono,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
  suggestions: string[];
  normalize: (raw: string) => string;
  display?: (tag: string) => string;
  mono?: boolean;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const values = raw
      .split(/[,\s]+/)
      .map(normalize)
      .filter((v) => v && !tags.includes(v));
    if (values.length) onChange([...tags, ...values]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (
      (e.key === "Enter" || e.key === "," || e.key === "Tab") &&
      text.trim()
    ) {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };
  const query = normalize(text).toLowerCase();
  const shown = suggestions
    .filter(
      (s) => !tags.includes(s) && (!query || s.toLowerCase().includes(query)),
    )
    .slice(0, 14);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        onClick={() => input.current?.focus()}
        className={`flex min-h-[34px] cursor-text flex-wrap items-center gap-1 rounded-md border bg-content/[0.03] px-1.5 py-1 ${
          focused ? "border-accent" : "border-content/12"
        }`}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className={`flex items-center gap-1 rounded bg-accent/15 py-0.5 pr-0.5 pl-1.5 text-[12px] text-content ${mono ? "font-mono" : ""}`}
          >
            {display(tag)}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(tags.filter((t) => t !== tag));
              }}
              className="grid size-4 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
            >
              <X className="size-2.5" strokeWidth={2} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={text}
          placeholder={tags.length ? "" : placeholder}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim()) add(text);
          }}
          className={`min-w-24 flex-1 bg-transparent px-1 text-[13px] text-content outline-none placeholder:text-content/30 ${mono ? "font-mono" : ""}`}
        />
      </div>
      {shown.length ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-content/40">Suggestions:</span>
          {shown.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange([...tags, s])}
              className={`rounded border border-dashed border-content/15 px-1.5 py-px text-[11px] text-content/60 hover:border-accent hover:text-content ${mono ? "font-mono" : ""}`}
            >
              + {display(s)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${checked ? "bg-accent" : "bg-content/20"}`}
      >
        <span
          className={`size-3 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-3" : ""}`}
        />
      </button>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] text-content/85">{label}</span>
        {hint ? (
          <span className="text-[11px] leading-snug text-content/45">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function SftpWatcherSection({
  workspace,
  context,
  watcher,
  onChange,
}: Props) {
  // The tags are the source of truth while editing; the glob is derived.
  const [sel, setSel] = useState<WatchSelection>(() =>
    parseWatchFiles(watcher?.files),
  );
  const files = useProjectFiles(workspace, context);
  const suggestions = useMemo(() => projectSuggestions(files ?? []), [files]);

  const enabled = !!watcher;
  const autoUpload = watcher?.autoUpload !== false;
  const autoDelete = watcher?.autoDelete === true;

  const apply = (next: WatchSelection) => {
    setSel(next);
    onChange({
      ...(watcher ?? {}),
      files: buildWatchFiles(next),
      autoUpload,
      autoDelete,
    });
  };

  const matching = useMemo(() => {
    if (!files) return null;
    return files.filter((f) => selectionMatches(sel, f));
  }, [files, sel]);

  const glob = buildWatchFiles(sel);
  const nothingChosen = !generatedGlob(sel) && sel.patterns.length === 0;

  return (
    <>
      <div className="mb-3">
        <h3 className="text-[14px] font-semibold text-content">File watcher</h3>
        <p className="mt-0.5 text-[12px] leading-snug text-content/50">
          Upload or delete files that change outside the editor, such as build
          output from a bundler or Sass. Pick what to watch below; MonoCode
          writes the pattern for you.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <Switch
          label="Watch files"
          checked={enabled}
          onChange={(v) =>
            onChange(
              v
                ? {
                    files: buildWatchFiles(sel),
                    autoUpload: true,
                    autoDelete: false,
                  }
                : undefined,
            )
          }
        />
        {enabled ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-content/80">
                File types
              </span>
              <div className="flex flex-wrap gap-1">
                {EXTENSION_PRESETS.map((p) => {
                  const active = p.extensions.every((e) =>
                    sel.extensions.includes(e),
                  );
                  return (
                    <button
                      key={p.label}
                      type="button"
                      title={p.extensions.map((e) => `.${e}`).join(" ")}
                      onClick={() =>
                        apply({
                          ...sel,
                          extensions: active
                            ? sel.extensions.filter(
                                (e) => !p.extensions.includes(e),
                              )
                            : [
                                ...new Set([
                                  ...sel.extensions,
                                  ...p.extensions,
                                ]),
                              ],
                        })
                      }
                      className={`rounded-full border px-2.5 py-0.5 text-[12px] ${
                        active
                          ? "border-accent bg-accent/15 text-content"
                          : "border-content/12 text-content/65 hover:border-content/25 hover:text-content"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <TagInput
                tags={sel.extensions}
                onChange={(extensions) => apply({ ...sel, extensions })}
                placeholder="Type an extension (css, js, php…) and press Enter — empty means all files"
                suggestions={suggestions.extensions}
                normalize={normalizeExtension}
                display={(t) => `.${t}`}
                mono
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-content/80">
                Only in these folders
              </span>
              <TagInput
                tags={sel.folders}
                onChange={(folders) => apply({ ...sel, folders })}
                placeholder="Optional — e.g. dist, assets/css. Empty means the whole project"
                suggestions={suggestions.folders}
                normalize={normalizeFolder}
                display={(t) => `${t}/`}
                mono
              />
            </div>

            <details className="group" open={sel.patterns.length > 0}>
              <summary className="cursor-pointer text-[12px] text-content/55 select-none hover:text-content/80">
                Custom patterns (advanced)
              </summary>
              <div className="mt-1.5 flex flex-col gap-1">
                <TagInput
                  tags={sel.patterns}
                  onChange={(patterns) => apply({ ...sel, patterns })}
                  placeholder="Glob, e.g. build/app.*.js — press Enter"
                  suggestions={[]}
                  normalize={(s) => s.trim()}
                  mono
                />
                <span className="text-[11px] text-content/45">
                  For anything the pickers can't express. A file matching any
                  rule is watched.
                </span>
              </div>
            </details>

            <div className="rounded-md border border-content/10 bg-content/[0.03] px-3 py-2 text-[12px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-content/50">Watching</span>
                <code className="font-mono text-content/85">
                  {Array.isArray(glob) ? glob.join("  ·  ") : glob}
                </code>
              </div>
              <div className="mt-1 text-content/50">
                {nothingChosen
                  ? "Every file in the project (except ignored ones)."
                  : matching === null
                    ? "Counting matching files…"
                    : `${matching.length} file${matching.length === 1 ? "" : "s"} in the project match right now${
                        sel.patterns.length
                          ? " (not counting custom patterns)"
                          : ""
                      }${matching.length ? `, e.g. ${matching.slice(0, 3).join(", ")}` : ""}.`}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Switch
                label="Upload changed and new files"
                checked={autoUpload}
                onChange={(v) =>
                  onChange({
                    ...watcher,
                    files: glob,
                    autoUpload: v,
                    autoDelete,
                  })
                }
              />
              <Switch
                label="Delete remote files when deleted locally"
                hint="Careful: deleting a local file removes it from the server too."
                checked={autoDelete}
                onChange={(v) =>
                  onChange({
                    ...watcher,
                    files: glob,
                    autoUpload,
                    autoDelete: v,
                  })
                }
              />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
