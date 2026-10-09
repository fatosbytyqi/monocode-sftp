import { describe, expect, it } from "vitest";
import {
  buildWatchFiles,
  parseWatchFiles,
  projectSuggestions,
  selectionMatches,
} from "./watchGlobs";

describe("watch globs", () => {
  it("builds globs from tags", () => {
    expect(buildWatchFiles({ extensions: [], folders: [], patterns: [] })).toBe(
      "**/*",
    );
    expect(
      buildWatchFiles({ extensions: [".css"], folders: [], patterns: [] }),
    ).toBe("**/*.css");
    expect(
      buildWatchFiles({
        extensions: ["css", "map"],
        folders: [],
        patterns: [],
      }),
    ).toBe("**/*.{css,map}");
    expect(
      buildWatchFiles({ extensions: ["js"], folders: ["dist/"], patterns: [] }),
    ).toBe("dist/**/*.js");
    expect(
      buildWatchFiles({
        extensions: [],
        folders: ["dist", "assets"],
        patterns: [],
      }),
    ).toBe("{dist,assets}/**/*");
    expect(
      buildWatchFiles({
        extensions: ["css"],
        folders: [],
        patterns: ["build/app.js"],
      }),
    ).toEqual(["**/*.css", "build/app.js"]);
  });

  it("parses globs back into tags, including the extension's dotted form", () => {
    expect(parseWatchFiles("**/*{.css,.map}")).toEqual({
      extensions: ["css", "map"],
      folders: [],
      patterns: [],
    });
    expect(parseWatchFiles("dist/**/*.{js,css}")).toEqual({
      extensions: ["js", "css"],
      folders: ["dist"],
      patterns: [],
    });
    expect(parseWatchFiles("{a,b/c}/**/*")).toEqual({
      extensions: [],
      folders: ["a", "b/c"],
      patterns: [],
    });
    expect(parseWatchFiles("**/*")).toEqual({
      extensions: [],
      folders: [],
      patterns: [],
    });
    expect(parseWatchFiles(["**/*.css", "src/*.ts"])).toEqual({
      extensions: ["css"],
      folders: [],
      patterns: ["src/*.ts"],
    });
  });

  it("round-trips", () => {
    for (const files of [
      "**/*.{css,map}",
      "dist/**/*.js",
      "{dist,web}/**/*.{png,svg}",
    ]) {
      expect(buildWatchFiles(parseWatchFiles(files))).toBe(files);
    }
  });

  it("matches project paths and suggests common types", () => {
    const sel = {
      extensions: ["css"],
      folders: ["wp-content/themes"],
      patterns: [],
    };
    expect(selectionMatches(sel, "wp-content/themes/a/style.css")).toBe(true);
    expect(selectionMatches(sel, "wp-content/plugins/x.css")).toBe(false);
    const s = projectSuggestions(["a/x.css", "a/y.css", "b/z.js", ".git/HEAD"]);
    expect(s.extensions[0]).toBe("css");
    expect(s.folders).toContain("a");
    expect(s.folders).not.toContain(".git");
  });
});
