import { invoke } from "@tauri-apps/api/core";
import { basename } from "../../../platform/tauri/fs";
import { nudgeWatchedFiles } from "../../files/model/fileWatch";
import { sftpOnSave } from "../../sftp/model/sftp";
import { loadCodeIntel } from "./codeIntelSettings";
import { reportCodeIntel } from "./codeIntelNotices";

type CompileResult = {
  outputs: string[];
  errors: string[];
  compiled: string[];
};

const STYLE_FILE = /\.(scss|sass|less)$/i;

/** Compile SCSS/Less after a save, then upload the CSS when SFTP uploads on save. */
export async function compileOnSave(path: string, root: string): Promise<void> {
  if (!STYLE_FILE.test(path)) return;
  const { compile } = loadCodeIntel();
  const isLess = /\.less$/i.test(path);
  if (isLess ? !compile.less : !compile.scss) return;
  let result: CompileResult;
  try {
    result = await invoke<CompileResult>("style_compile", {
      path,
      root,
      options: {
        scss: compile.scss,
        less: compile.less,
        style: compile.style,
        sourceMap: compile.sourceMap,
        outDir: compile.outDir,
      },
    });
  } catch (error) {
    reportCodeIntel(
      `Compile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const error of result.errors) reportCodeIntel(error);
  if (!result.outputs.length) return;
  const css = result.outputs.filter((o) => o.endsWith(".css"));
  reportCodeIntel(
    `Compiled ${result.compiled.map((c) => basename(c)).join(", ")} → ${css.map((c) => basename(c)).join(", ")}`,
    false,
  );
  nudgeWatchedFiles(result.outputs);
  if (compile.uploadAfterCompile) {
    for (const output of result.outputs) {
      await sftpOnSave(output).catch(() => null);
    }
  }
}
