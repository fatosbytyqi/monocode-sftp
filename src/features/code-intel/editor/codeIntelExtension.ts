import type { Extension } from "@codemirror/state";
import { isRemoteProjectPath } from "../../projects/model/recents";
import {
  lspServerForPath,
  type CodeIntelSettings,
} from "../model/codeIntelSettings";
import { lspExtension } from "../model/lspClients";
import { reportCodeIntel } from "../model/codeIntelNotices";
import { aiInline } from "./aiInline";
import { snippetsExtension, wordCompletion } from "./completions";

/** Everything Settings → Code Editor turns on, for one open file. */
export async function buildCodeIntel(
  path: string,
  root: string,
  settings: CodeIntelSettings,
): Promise<Extension> {
  const out: Extension[] = [];
  if (settings.wordCompletion) out.push(wordCompletion);
  if (settings.snippets) out.push(snippetsExtension(path));
  const local = root && root !== "~" && !isRemoteProjectPath(root);
  if (settings.ai.enabled && local) {
    out.push(
      aiInline({
        path,
        model: settings.ai.model,
        debounceMs: settings.ai.debounceMs,
        maxTokens: settings.ai.maxTokens,
        onError: (message) => reportCodeIntel(`AI suggestions: ${message}`),
      }),
    );
  }
  const server = lspServerForPath(path);
  if (settings.lsp.enabled && local && server && settings.lsp[server]) {
    const ext = await lspExtension(server, root, path);
    if (ext) out.push(ext);
  }
  return out;
}
