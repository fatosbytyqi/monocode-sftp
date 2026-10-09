import { invoke } from "@tauri-apps/api/core";
import { completionStatus } from "@codemirror/autocomplete";
import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Text,
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

type Ghost = { pos: number; text: string; doc: Text };

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost";
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost): DecorationSet =>
      ghost
        ? Decoration.set([
            Decoration.widget({
              widget: new GhostWidget(ghost.text),
              side: 1,
            }).range(ghost.pos),
          ])
        : Decoration.none,
    ),
});

function accept(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost || ghost.doc !== view.state.doc) return false;
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
  model: string;
  debounceMs: number;
  maxTokens: number;
  onError?: (message: string) => void;
};

/** AI ghost-text completions: Tab accepts, Escape dismisses. */
export function aiInline(options: AiInlineOptions): Extension {
  let lastError = "";
  const plugin = ViewPlugin.fromClass(
    class {
      timer = 0;
      request = 0;
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate) {
        const typed = update.transactions.some(
          (tr) =>
            tr.isUserEvent("input.type") || tr.isUserEvent("delete.backward"),
        );
        if (!update.docChanged && !update.selectionSet) return;
        window.clearTimeout(this.timer);
        this.request++;
        if (!typed) return;
        this.timer = window.setTimeout(
          () => void this.ask(),
          options.debounceMs,
        );
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
        try {
          const text = await invoke<string>("ai_complete", {
            request: {
              prefix: doc.sliceString(0, pos),
              suffix: doc.sliceString(pos),
              path: options.path,
              model: options.model,
              maxTokens: options.maxTokens,
            },
          });
          if (id !== this.request || this.view.state.doc !== doc || !text)
            return;
          this.view.dispatch({ effects: setGhost.of({ pos, text, doc }) });
          lastError = "";
        } catch (error) {
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
    }),
  ];
}
