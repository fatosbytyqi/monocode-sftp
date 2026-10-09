import {
  canRunHarnessTextPrompt,
  getHarness,
  isHarnessAvailable,
  runHarnessTextPrompt,
} from "../../../integrations/harness";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { modelsFor, nativeModelId } from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";

const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;
const TIMEOUT_MS = 45_000;

/** Providers tried, in order, when the setting is "auto". */
const AUTO_ORDER: HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "antigravity",
  "hermes",
  "fx",
];

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
    "Do not use tools, do not read or edit files: answer from the text below only.",
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

/** Whether a provider can answer completions at all (installed and wired up). */
export function completionProviderReady(harness: HarnessId): boolean {
  const adapter = getHarness(harness);
  return isHarnessAvailable(harness) && adapter?.live === true;
}

/** The provider "auto" resolves to right now, if any. */
export function resolveCompletionProvider(setting: string): HarnessId | null {
  if (setting !== "auto" && (HARNESSES as string[]).includes(setting)) {
    return setting as HarnessId;
  }
  return AUTO_ORDER.find(completionProviderReady) ?? null;
}

/** The model to request: the chosen one, or the provider's first model. */
function resolveModel(harness: HarnessId, model: string | undefined): string {
  if (model && model !== "auto") return model;
  return modelsFor(harness)[0]?.id ?? "";
}

/**
 * Providers without an isolated text-prompt backend (Antigravity, Hermes, fx)
 * answer through a hidden, read-only one-off session that is forgotten after.
 */
async function promptViaHiddenSession(input: {
  harness: HarnessId;
  cwd: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const adapter = getHarness(input.harness);
  if (!adapter) throw new Error(`${input.harness} is not available`);
  const sessionId = `monocode-completion-${crypto.randomUUID()}`;
  let output = "";
  let failure: string | null = null;
  const onEvent = (event: HarnessEvent) => {
    switch (event.type) {
      case "message.delta":
        output += event.text;
        break;
      case "approval.requested":
        // Completions never run tools.
        adapter.respondApproval(sessionId, event.requestId, "deny");
        break;
      case "session.error":
        failure = event.message;
        break;
    }
  };
  const onAbort = () => void adapter.cancelTurn(sessionId).catch(() => {});
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([
      adapter.sendTurn({
        sessionId,
        cwd: input.cwd,
        model: input.model,
        runtimeMode: "supervised",
        intent: "plan",
        ephemeral: true,
        text: input.prompt,
        onEvent,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${input.harness} timed out`)),
          TIMEOUT_MS,
        ),
      ),
    ]);
    input.signal?.throwIfAborted();
    if (failure && !output) throw new Error(failure);
    return output;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    void adapter.forgetSession(sessionId).catch(() => {});
  }
}

/**
 * Ask any installed agent for an inline completion, the same way MonoCode runs
 * its read-only side prompts: through the provider's own sign-in, no API key.
 */
export async function completeWithAgent(input: {
  provider: string;
  model?: string;
  cwd: string;
  path: string;
  prefix: string;
  suffix: string;
  signal?: AbortSignal;
}): Promise<string> {
  const harness = resolveCompletionProvider(input.provider);
  if (!harness) {
    throw new Error(
      "No installed agent can answer. Install and sign in to one in Settings → Providers.",
    );
  }
  if (!completionProviderReady(harness)) {
    throw new Error(`${harness} is not installed or not signed in`);
  }
  const prompt = buildCompletionPrompt(input.path, input.prefix, input.suffix);
  const model = resolveModel(harness, input.model);
  const output = canRunHarnessTextPrompt(harness)
    ? await runHarnessTextPrompt({
        harness,
        cwd: input.cwd,
        model: model ? nativeModelId(model) : undefined,
        // Read-only, single turn: a completion must never run tools or edit files.
        intent: "plan",
        ephemeral: true,
        prompt,
        timeoutMs: TIMEOUT_MS,
        signal: input.signal,
      })
    : await promptViaHiddenSession({
        harness,
        cwd: input.cwd,
        model,
        prompt,
        signal: input.signal,
      });
  return parseCompletion(output, input.prefix);
}
