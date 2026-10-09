import { describe, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/providers/claude/claudeText", () => ({
  runClaudeTextPrompt: vi.fn(
    async () => "Sure:\n<insert>\n  return $a;</insert>",
  ),
}));

import { runClaudeTextPrompt } from "../../../integrations/harness/providers/claude/claudeText";
import {
  buildCompletionPrompt,
  completeWithClaude,
  parseCompletion,
} from "./aiComplete";

describe("AI completion via Claude Code", () => {
  it("keeps leading whitespace and newlines inside <insert>", () => {
    expect(
      parseCompletion("<insert>\n  return $a;\n</insert>", "function f() {"),
    ).toBe("\n  return $a;");
    expect(parseCompletion("<insert></insert>", "x")).toBe("");
    expect(parseCompletion("no tags at all", "x")).toBe("");
  });

  it("strips fences and an echo of the current line", () => {
    expect(parseCompletion("<insert>```php\necho 1;\n```</insert>", "")).toBe(
      "echo 1;",
    );
    expect(parseCompletion("<insert>$a = 1;</insert>", "    $a")).toBe(" = 1;");
  });

  it("bounds the context sent", () => {
    const prompt = buildCompletionPrompt(
      "x.php",
      "a".repeat(20_000),
      "b".repeat(20_000),
    );
    expect(prompt.length).toBeLessThan(9_000);
    expect(prompt).toContain("<prefix>");
  });

  it("asks read-only and single-turn, without an API key", async () => {
    const text = await completeWithClaude({
      cwd: "/p",
      path: "/p/a.php",
      prefix: "function f() {",
      suffix: "}",
    });
    expect(text).toBe("\n  return $a;");
    expect(runClaudeTextPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/p", intent: "plan", model: undefined }),
    );
  });
});
