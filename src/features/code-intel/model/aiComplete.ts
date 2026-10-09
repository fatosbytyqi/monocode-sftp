import { runClaudeTextPrompt } from "../../../integrations/harness/providers/claude/claudeText";

const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;
const TIMEOUT_MS = 30_000;

export function buildCompletionPrompt(
  path: string,
  prefix: string,
  suffix: string,
): string {
  const before = prefix.slice(-PREFIX_CHARS);
  const after = suffix.slice(0, SUFFIX_CHARS);
  return [
    "You are an inline code completion engine inside a code editor.",
    `File: ${path}`,
    "The code before the cursor is in <prefix>, the code after it is in <suffix>.",
    "Reply with exactly one <insert>…</insert> block containing only the text to insert at the cursor:",
    "no explanations, no markdown fences, and never repeat text that is already in the prefix or suffix.",
    "Prefer finishing the current line or statement; insert at most a few lines; keep the file's indentation and style.",
    "If nothing useful fits, reply with <insert></insert>.",
    "",
    `<prefix>${before}</prefix><suffix>${after}</suffix>`,
  ].join("\n");
}

/** Text between <insert> tags, with any echo of the current line removed. */
export function parseCompletion(output: string, prefix: string): string {
  const match = /<insert>([\s\S]*?)<\/insert>/.exec(output);
  let text = match ? match[1]! : "";
  if (/^\s*```/.test(text)) {
    text = text.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  }
  text = text.replace(/\s+$/, "");
  const line = (prefix.split("\n").pop() ?? "").trimStart();
  if (line && text.startsWith(line)) text = text.slice(line.length);
  return text;
}

/**
 * Ask Claude for a completion the same way MonoCode writes session titles and
 * commit messages: through the signed-in Claude Code CLI, no API key.
 */
export async function completeWithClaude(input: {
  cwd: string;
  path: string;
  prefix: string;
  suffix: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const output = await runClaudeTextPrompt({
    cwd: input.cwd,
    model: input.model,
    // Read-only, single turn: a completion must never run tools or edit files.
    intent: "plan",
    prompt: buildCompletionPrompt(input.path, input.prefix, input.suffix),
    timeoutMs: TIMEOUT_MS,
    signal: input.signal,
  });
  return parseCompletion(output, input.prefix);
}
