import { beforeEach, describe, expect, it, vi } from "vitest";

const available = new Set<string>();
const textCapable = new Set([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
]);
const respondApproval = vi.fn();
const forgetSession = vi.fn(async () => {});
const sendTurn = vi.fn(async (input: { onEvent: (e: unknown) => void }) => {
  input.onEvent({
    type: "approval.requested",
    requestId: 7,
    title: "Read file",
  });
  input.onEvent({ type: "message.delta", text: "<insert>\n  return 1;" });
  input.onEvent({ type: "message.delta", text: "</insert>" });
});

vi.mock("../../../integrations/harness", () => ({
  isHarnessAvailable: (id: string) => available.has(id),
  getHarness: () => ({
    live: true,
    sendTurn,
    respondApproval,
    forgetSession,
    cancelTurn: vi.fn(async () => {}),
  }),
  canRunHarnessTextPrompt: (id: string) => textCapable.has(id),
  runHarnessTextPrompt: vi.fn(async () => "<insert>$x = 1;</insert>"),
}));

vi.mock("../../sessions/model/models", () => ({
  modelsFor: (h: string) => [
    { id: `${h}-default`, name: "Default", harness: h },
  ],
  nativeModelId: (id: string) => `native:${id}`,
}));

import { runHarnessTextPrompt } from "../../../integrations/harness";
import {
  buildCompletionPrompt,
  completeWithAgent,
  parseCompletion,
  resolveCompletionProvider,
  stopWarmCompletions,
} from "./aiComplete";

beforeEach(() => {
  stopWarmCompletions();
  available.clear();
  vi.clearAllMocks();
});

describe("AI completion through installed agents", () => {
  it("keeps whitespace inside <insert> and drops echoes", () => {
    expect(parseCompletion("<insert>\n  return $a;\n</insert>", "f() {")).toBe(
      "\n  return $a;",
    );
    expect(parseCompletion("<insert>```php\necho 1;\n```</insert>", "")).toBe(
      "echo 1;",
    );
    expect(parseCompletion("<insert>$a = 1;</insert>", "    $a")).toBe(" = 1;");
    expect(parseCompletion("nothing", "x")).toBe("");
  });

  it("bounds the context sent", () => {
    const prompt = buildCompletionPrompt(
      "x.php",
      "a".repeat(20_000),
      "b".repeat(20_000),
    );
    expect(prompt.length).toBeLessThan(9_000);
  });

  it("auto picks the first installed agent", () => {
    expect(resolveCompletionProvider("auto")).toBeNull();
    available.add("antigravity");
    available.add("codex");
    expect(resolveCompletionProvider("auto")).toBe("codex");
    expect(resolveCompletionProvider("antigravity")).toBe("antigravity");
  });

  it("uses the shared read-only text prompt where the provider has one", async () => {
    available.add("codex");
    const text = await completeWithAgent({
      provider: "codex",
      model: "auto",
      cwd: "/p",
      path: "/p/a.php",
      prefix: "",
      suffix: "",
    });
    expect(text).toBe("$x = 1;");
    expect(runHarnessTextPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "codex",
        intent: "plan",
        keepWarm: true,
        model: "native:codex-default",
        modelSettings: expect.objectContaining({ reasoningEffort: "low" }),
      }),
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("falls back to a hidden read-only session (Antigravity) and denies tool use", async () => {
    available.add("antigravity");
    const text = await completeWithAgent({
      provider: "antigravity",
      model: "auto",
      cwd: "/p",
      path: "/p/a.ts",
      prefix: "function f() {",
      suffix: "}",
    });
    expect(text).toBe("\n  return 1;");
    expect(sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "plan",
        runtimeMode: "supervised",
        model: "antigravity-default",
      }),
    );
    expect(respondApproval).toHaveBeenCalledWith(
      expect.stringMatching(/^monocode-completion-/),
      7,
      "deny",
    );
    // The hidden session stays open for the next suggestion…
    expect(forgetSession).not.toHaveBeenCalled();
    const first = (
      sendTurn.mock.calls[0]![0] as unknown as { sessionId: string }
    ).sessionId;
    await completeWithAgent({
      provider: "antigravity",
      model: "auto",
      cwd: "/p",
      path: "/p/a.ts",
      prefix: "",
      suffix: "",
    });
    expect(
      (sendTurn.mock.calls[1]![0] as unknown as { sessionId: string })
        .sessionId,
    ).toBe(first);
    // …until suggestions are switched off.
    stopWarmCompletions();
    expect(forgetSession).toHaveBeenCalledWith(first);
  });

  it("explains when nothing is installed", async () => {
    await expect(
      completeWithAgent({
        provider: "auto",
        cwd: "/p",
        path: "a",
        prefix: "",
        suffix: "",
      }),
    ).rejects.toThrow(/No installed agent/);
  });
});
