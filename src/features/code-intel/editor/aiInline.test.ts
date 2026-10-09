// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("../model/aiComplete", () => ({
  completeWithAgent: vi.fn(),
  prewarmCompletions: vi.fn(),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { aiInline, __test } from "./aiInline";

function setup(doc: string) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: aiInline({
        path: "a.php",
        cwd: "/p",
        provider: "auto",
        model: "auto",
        debounceMs: 10_000,
      }),
    }),
  });
  return view;
}

describe("AI ghost text", () => {
  it("keeps the rest of the suggestion while the user types it", () => {
    const view = setup("$sum");
    __test.show(view, " += $item;");
    view.dispatch({
      changes: { from: 4, insert: " +" },
      selection: { anchor: 6 },
      userEvent: "input.type",
    });
    expect(__test.ghost(view)).toBe("= $item;");
    view.dispatch({
      changes: { from: 6, insert: "x" },
      selection: { anchor: 7 },
      userEvent: "input.type",
    });
    expect(__test.ghost(view)).toBeNull();
  });

  it("Tab inserts the suggestion", () => {
    const view = setup("$sum");
    __test.show(view, " += 1;");
    expect(__test.accept(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("$sum += 1;");
    expect(__test.ghost(view)).toBeNull();
  });
});
