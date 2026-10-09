import { completionStatus } from "@codemirror/autocomplete";
import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { completeWithAgent, prewarmCompletions } from "../model/aiComplete";

type Ghost = { pos: number; text: string; doc: Text; pending?: boolean };

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly pending = false,
  ) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text && other.pending === this.pending;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.pending ? "cm-ai-ghost cm-ai-pending" : "cm-ai-ghost";
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * Typing the same characters the suggestion starts with keeps the rest of it
 * on screen instead of asking again.
 */
function typedIntoGhost(ghost: Ghost, tr: Transaction): Ghost | null {
  if (ghost.pending || !tr.isUserEvent("input.type")) return null;
  let inserted: string | null = null;
  let valid = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    if (inserted !== null || fromA !== ghost.pos || toA !== fromA)
      valid = false;
    inserted = text.toString();
  });
  const typed = inserted as string | null;
  if (!valid || !typed || !ghost.text.startsWith(typed)) return null;
  const rest = ghost.text.slice(typed.length);
  if (!rest) return null;
  return { pos: ghost.pos + typed.length, text: rest, doc: tr.newDoc };
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!value) return null;
    if (tr.docChanged) return typedIntoGhost(value, tr);
    if (tr.selection) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost): DecorationSet =>
      ghost
        ? Decoration.set([
            Decoration.widget({
              widget: new GhostWidget(ghost.text, ghost.pending),
              side: 1,
            }).range(ghost.pos),
          ])
        : Decoration.none,
    ),
});

function accept(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost || ghost.pending || ghost.doc !== view.state.doc) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: "input.complete",
  });
  return true;
}

function dismiss(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

export type AiInlineOptions = {
  path: string;
  cwd: string;
  /** "auto" or a provider id (claude, codex, antigravity, …). */
  provider: string;
  /** "auto" or a model id for that provider. */
  model: string;
  debounceMs: number;
  onError?: (message: string) => void;
};

/** AI ghost-text completions: Tab accepts, Escape dismisses. */
export function aiInline(options: AiInlineOptions): Extension {
  let lastError = "";
  const plugin = ViewPlugin.fromClass(
    class {
      timer = 0;
      request = 0;
      inFlight: AbortController | null = null;
      constructor(readonly view: EditorView) {
        // Start the agent now so the first suggestion is already warm.
        prewarmCompletions(options.provider, options.model, options.cwd);
      }
      update(update: ViewUpdate) {
        const typed = update.transactions.some(
          (tr) =>
            tr.isUserEvent("input.type") || tr.isUserEvent("delete.backward"),
        );
        if (!update.docChanged && !update.selectionSet) return;
        window.clearTimeout(this.timer);
        this.request++;
        this.cancel();
        if (!typed) return;
        // The user is typing along a suggestion that is still on screen.
        if (update.state.field(ghostField, false)) return;
        this.timer = window.setTimeout(
          () => void this.ask(),
          options.debounceMs,
        );
      }
      cancel() {
        this.inFlight?.abort();
        this.inFlight = null;
      }
      async ask() {
        const state = this.view.state;
        const sel = state.selection.main;
        if (!sel.empty || completionStatus(state) === "active") return;
        const pos = sel.head;
        const line = state.doc.lineAt(pos);
        // Only mid-line when the rest of the line is closing punctuation.
        if (!/^[\s)\]}>;,'"`]*$/.test(line.text.slice(pos - line.from))) return;
        const id = ++this.request;
        const doc = state.doc;
        const controller = new AbortController();
        this.inFlight = controller;
        this.view.dispatch({
          effects: setGhost.of({ pos, text: " …", doc, pending: true }),
        });
        try {
          const text = await completeWithAgent({
            provider: options.provider,
            cwd: options.cwd,
            path: options.path,
            prefix: doc.sliceString(0, pos),
            suffix: doc.sliceString(pos),
            model: options.model,
            signal: controller.signal,
            onPartial: (partial) => {
              if (id !== this.request || this.view.state.doc !== doc) return;
              this.view.dispatch({
                effects: setGhost.of({ pos, text: partial, doc }),
              });
            },
          });
          if (this.inFlight === controller) this.inFlight = null;
          if (id !== this.request || this.view.state.doc !== doc) return;
          if (!text) {
            this.view.dispatch({ effects: setGhost.of(null) });
            return;
          }
          this.view.dispatch({ effects: setGhost.of({ pos, text, doc }) });
          lastError = "";
        } catch (error) {
          if (this.inFlight === controller) this.inFlight = null;
          if (controller.signal.aborted) return;
          if (this.view.state.field(ghostField, false)?.pending) {
            this.view.dispatch({ effects: setGhost.of(null) });
          }
          const message =
            error instanceof Error ? error.message : String(error);
          if (message !== lastError) {
            lastError = message;
            options.onError?.(message);
          }
        }
      }
      destroy() {
        window.clearTimeout(this.timer);
        this.request++;
        this.cancel();
      }
    },
  );
  return [
    ghostField,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: accept },
        { key: "Escape", run: dismiss },
      ]),
    ),
    EditorView.baseTheme({
      ".cm-ai-ghost": {
        opacity: "0.45",
        fontStyle: "italic",
        whiteSpace: "pre",
      },
      ".cm-ai-pending": {
        animation: "cm-ai-pulse 1s ease-in-out infinite",
      },
      "@keyframes cm-ai-pulse": {
        "0%, 100%": { opacity: "0.2" },
        "50%": { opacity: "0.6" },
      },
    }),
  ];
}

/** Test hooks. */
export const __test = {
  show(view: EditorView, text: string) {
    const pos = view.state.selection.main.head;
    view.dispatch({ effects: setGhost.of({ pos, text, doc: view.state.doc }) });
  },
  ghost(view: EditorView): string | null {
    return view.state.field(ghostField, false)?.text ?? null;
  },
  accept,
};
