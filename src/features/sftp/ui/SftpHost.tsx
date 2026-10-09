import { useEffect, useRef, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { Modal } from "../../../shared/ui/Modal";
import { LAYER } from "../../../shared/lib/layers";
import { X } from "../../../shared/ui/icons";
import {
  answerPrompt,
  closeDiff,
  dismissError,
  report,
  sftpDownload,
  sftpUpload,
  sftpWorkspaceOf,
  useSftpState,
  type DiffView,
  type PromptRequest,
} from "../model/sftp";

/** App-wide SFTP UI: credential prompts, the diff viewer and the status toast. */
export function SftpHost() {
  const prompt = useSftpState((s) => s.prompts[0] ?? null);
  const diff = useSftpState((s) => s.diff);
  return (
    <>
      {prompt ? <PromptDialog key={prompt.id} prompt={prompt} /> : null}
      {diff ? <DiffDialog diff={diff} /> : null}
      <StatusToast />
    </>
  );
}

function PromptDialog({ prompt }: { prompt: PromptRequest }) {
  const [value, setValue] = useState("");
  const submit = (answer: string | null) => answerPrompt(prompt.id, answer);
  return (
    <Modal title={prompt.title} size="sm" onClose={() => submit(null)}>
      <form
        className="flex flex-col gap-3 px-4 pt-2 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit(prompt.confirm ? "yes" : value);
        }}
      >
        <p className="text-[13px] whitespace-pre-wrap break-words text-content/75">
          {prompt.message}
        </p>
        {prompt.confirm ? null : (
          <input
            autoFocus
            type={prompt.secret ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="rounded-md border border-content/15 bg-transparent px-2 py-1.5 text-[13px] text-content outline-none focus:border-accent"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => submit(null)}
            className="rounded-md px-3 py-1 text-[12px] text-content/70 hover:bg-content/8"
          >
            {prompt.confirm ? "No" : "Cancel"}
          </button>
          <button
            type="submit"
            autoFocus={prompt.confirm}
            className="rounded-md bg-accent px-3 py-1 text-[12px] text-white hover:opacity-90"
          >
            {prompt.confirm ? "Yes" : "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DiffDialog({ diff }: { diff: DiffView }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || diff.binary) return;
    const readOnly = [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ];
    const view = new MergeView({
      a: { doc: diff.remote ?? "", extensions: readOnly },
      b: { doc: diff.local, extensions: readOnly },
      parent: host.current,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    return () => view.destroy();
  }, [diff]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDiff();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const transfer = async (up: boolean) => {
    const workspace = await sftpWorkspaceOf(diff.path);
    if (!workspace) return;
    await report(
      up
        ? sftpUpload(workspace, [diff.path])
        : sftpDownload(workspace, [diff.path]),
    );
    closeDiff();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40 p-6"
      style={{ zIndex: LAYER.dialog }}
    >
      <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-content/10 bg-background-base shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-stroke px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-content">
              {diff.path.split("/").pop()}
            </div>
            <div className="truncate text-[11px] text-content/50">
              Remote {diff.remotePath} ↔ Local {diff.path}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void transfer(false)}
            className="rounded-md border border-content/10 px-2.5 py-1 text-[12px] text-content/75 hover:bg-content/8"
          >
            Download remote
          </button>
          <button
            type="button"
            onClick={() => void transfer(true)}
            className="rounded-md border border-content/10 px-2.5 py-1 text-[12px] text-content/75 hover:bg-content/8"
          >
            Upload local
          </button>
          <button
            type="button"
            aria-label="Close diff"
            onClick={closeDiff}
            className="grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </header>
        <div className="grid shrink-0 grid-cols-2 border-b border-stroke text-[11px] text-content/50">
          <div className="px-4 py-1">
            Remote{diff.remote === null ? " (does not exist)" : ""}
          </div>
          <div className="px-4 py-1">Local</div>
        </div>
        {diff.binary ? (
          <p className="p-4 text-[13px] text-content/60">
            Binary files differ; no text diff to show.
          </p>
        ) : diff.remote === diff.local ? (
          <p className="p-4 text-[13px] text-content/60">
            The files are identical.
          </p>
        ) : null}
        <div
          ref={host}
          className="sftp-diff min-h-0 flex-1 overflow-auto text-[12px]"
        />
      </div>
    </div>
  );
}

function StatusToast() {
  const status = useSftpState((s) => s.status);
  const error = useSftpState((s) => s.lastError);
  const [showDone, setShowDone] = useState(false);
  const running = status.running > 0;
  useEffect(() => {
    if (running) {
      setShowDone(true);
      return;
    }
    const t = window.setTimeout(() => setShowDone(false), 2500);
    return () => window.clearTimeout(t);
  }, [running]);

  if (!error && !running && !showDone) return null;
  return (
    <div
      className="fixed bottom-4 right-4 flex max-w-sm flex-col gap-2"
      style={{ zIndex: LAYER.toast }}
    >
      {running || showDone ? (
        <div className="rounded-xl border border-content/10 bg-background-base px-3 py-2 text-[12px] text-content/80 shadow-xl">
          {running ? "⟳ " : "✓ "}
          {status.label || "SFTP"}
          {status.total ? ` · ${status.done}/${status.total}` : ""}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-background-base px-3 py-2 text-[12px] text-red-400 shadow-xl"
        >
          <span className="min-w-0 break-words">SFTP: {error}</span>
          <button
            type="button"
            onClick={dismissError}
            className="shrink-0 text-content/60 hover:text-content"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
