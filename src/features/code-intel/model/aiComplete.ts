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
/** Start a fresh conversation after this many suggestions, so history stays small. */
const RECYCLE_AFTER = 8;
/** Shut the warm backend down after this long without suggestions. */
const IDLE_MS = 3 * 60_000;

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
    "Each request is independent: ignore any earlier requests in this conversation.",
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

type Warm = {
  uses: number;
  idle?: ReturnType<typeof setTimeout>;
  hiddenSession?: string;
};
const warm = new Map<HarnessId, Warm>();

function stopWarm(harness: HarnessId) {
  const state = warm.get(harness);
  warm.delete(harness);
  if (!state) return;
  clearTimeout(state.idle);
  const adapter = getHarness(harness);
  if (state.hiddenSession) {
    void adapter?.forgetSession(state.hiddenSession).catch(() => {});
  } else {
    void adapter?.stopTextPrompt?.().catch(() => {});
  }
}

/** Count a use of the warm backend; recycle it when it has served enough. */
function touchWarm(harness: HarnessId): Warm {
  let state = warm.get(harness);
  if (state && state.uses >= RECYCLE_AFTER) {
    stopWarm(harness);
    state = undefined;
  }
  if (!state) {
    state = { uses: 0 };
    warm.set(harness, state);
  }
  state.uses++;
  clearTimeout(state.idle);
  state.idle = setTimeout(() => stopWarm(harness), IDLE_MS);
  return state;
}

/** Turn off every warm completion backend (e.g. when AI suggestions are switched off). */
export function stopWarmCompletions() {
  for (const harness of [...warm.keys()]) stopWarm(harness);
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
  // One hidden session per provider stays open between suggestions.
  const state = touchWarm(input.harness);
  state.hiddenSession ??= `monocode-completion-${crypto.randomUUID()}`;
  const sessionId = state.hiddenSession;
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
  } catch (error) {
    // A failed or cancelled turn leaves the session in an unknown state.
    stopWarm(input.harness);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
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
  if (canRunHarnessTextPrompt(harness)) touchWarm(harness);
  const output = canRunHarnessTextPrompt(harness)
    ? await runHarnessTextPrompt({
        harness,
        cwd: input.cwd,
        model: model ? nativeModelId(model) : undefined,
        // Read-only, single turn: a completion must never run tools or edit files.
        intent: "plan",
        ephemeral: true,
        // Reuse one running process instead of starting the CLI per suggestion.
        keepWarm: true,
        // Ask for quick answers where the provider supports an effort level.
        modelSettings: { effort: "low", reasoningEffort: "low" },
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
