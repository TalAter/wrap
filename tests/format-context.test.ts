import { describe, expect, test } from "bun:test";
import { type FormatContextParams, formatContext } from "../src/llm/format-context.ts";
import constants from "../src/prompt.constants.json";

function makeParams(overrides?: Partial<FormatContextParams>): FormatContextParams {
  return {
    memory: {},
    cwd: "/home/user",
    constants,
    ...overrides,
  };
}

describe("formatContext", () => {
  test("returns cwd line when no memory, tools, or piped", () => {
    const result = formatContext(makeParams());
    expect(result).toBe("- Working directory (cwd): /home/user");
  });

  test("global facts use '## System facts' header", () => {
    const result = formatContext(makeParams({ memory: { "/": [{ fact: "macOS arm64" }] } }));
    expect(result).toContain("## System facts");
    expect(result).toContain("- macOS arm64");
    expect(result).not.toContain("## Facts about /");
  });

  test("directory scope uses '## Facts about {path}' header", () => {
    const result = formatContext(
      makeParams({
        cwd: "/Users/tal/project",
        memory: {
          "/": [{ fact: "macOS" }],
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(result).toContain("## Facts about /Users/tal/project");
    expect(result).toContain("- Uses bun");
  });

  test("subdirectory CWD matches parent scope", () => {
    const result = formatContext(
      makeParams({
        cwd: "/Users/tal/project/packages/api",
        memory: { "/Users/tal/project": [{ fact: "Uses bun" }] },
      }),
    );
    expect(result).toContain("Uses bun");
  });

  test("unrelated directory scope excluded", () => {
    const result = formatContext(
      makeParams({
        cwd: "/Users/tal/other",
        memory: {
          "/": [{ fact: "macOS" }],
          "/Users/tal/project": [{ fact: "Uses bun" }],
        },
      }),
    );
    expect(result).toContain("macOS");
    expect(result).not.toContain("Uses bun");
  });

  test("sibling directory with shared prefix excluded", () => {
    const result = formatContext(
      makeParams({
        cwd: "/monorepo-tools",
        memory: { "/monorepo": [{ fact: "monorepo fact" }] },
      }),
    );
    expect(result).not.toContain("monorepo fact");
  });

  test("sections ordered global then specific", () => {
    const result = formatContext(
      makeParams({
        cwd: "/Users/tal/project/packages/api",
        memory: {
          "/": [{ fact: "global" }],
          "/Users/tal/project": [{ fact: "project" }],
          "/Users/tal/project/packages/api": [{ fact: "api" }],
        },
      }),
    );
    const globalIdx = result.indexOf("## System facts");
    const projectIdx = result.indexOf("## Facts about /Users/tal/project\n");
    const apiIdx = result.indexOf("## Facts about /Users/tal/project/packages/api");
    expect(globalIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(apiIdx);
  });

  test("facts within scope preserve insertion order", () => {
    const result = formatContext(
      makeParams({
        memory: { "/": [{ fact: "first" }, { fact: "second" }, { fact: "third" }] },
      }),
    );
    expect(result.indexOf("first")).toBeLessThan(result.indexOf("second"));
    expect(result.indexOf("second")).toBeLessThan(result.indexOf("third"));
  });

  test("empty memory produces no facts sections", () => {
    const result = formatContext(makeParams({ memory: {} }));
    expect(result).not.toContain("System facts");
    expect(result).not.toContain("Facts about");
  });

  test("scope with empty facts array excluded", () => {
    const result = formatContext(makeParams({ memory: { "/": [] } }));
    expect(result).not.toContain("System facts");
  });

  test("detected tools section included when available tools provided", () => {
    const result = formatContext(
      makeParams({ tools: { available: ["/usr/bin/git", "/usr/bin/curl"], unavailable: [] } }),
    );
    expect(result).toContain("## Detected tools");
    expect(result).toContain("/usr/bin/git");
    expect(result).toContain("/usr/bin/curl");
  });

  test("unavailable tools section included when unavailable tools provided", () => {
    const result = formatContext(
      makeParams({
        tools: { available: ["/usr/bin/git"], unavailable: ["docker", "kubectl"] },
      }),
    );
    expect(result).toContain("## Unavailable tools");
    expect(result).toContain("docker, kubectl");
  });

  test("unavailable tools rendered as comma-separated single line", () => {
    const result = formatContext(
      makeParams({
        tools: { available: [], unavailable: ["apt", "dnf", "pacman"] },
      }),
    );
    const lines = result.split("\n");
    const unavailLine = lines.find((l) => l.includes("apt"));
    expect(unavailLine).toBe("apt, dnf, pacman");
  });

  test("tools sections omitted when tools not provided", () => {
    const result = formatContext(makeParams());
    expect(result).not.toContain("Detected tools");
    expect(result).not.toContain("Unavailable tools");
  });

  test("tools sections omitted when both arrays empty", () => {
    const result = formatContext(makeParams({ tools: { available: [], unavailable: [] } }));
    expect(result).not.toContain("Detected tools");
    expect(result).not.toContain("Unavailable tools");
  });

  test("tools sections omitted when tools is null", () => {
    const result = formatContext(makeParams({ tools: null }));
    expect(result).not.toContain("Detected tools");
    expect(result).not.toContain("Unavailable tools");
  });

  test("only detected tools section when no unavailable", () => {
    const result = formatContext(
      makeParams({ tools: { available: ["/usr/bin/git"], unavailable: [] } }),
    );
    expect(result).toContain("## Detected tools");
    expect(result).not.toContain("Unavailable tools");
  });

  test("only unavailable tools section when no available", () => {
    const result = formatContext(makeParams({ tools: { available: [], unavailable: ["docker"] } }));
    expect(result).not.toContain("Detected tools");
    expect(result).toContain("## Unavailable tools");
  });

  test("tools sections appear after memory and before cwd", () => {
    const result = formatContext(
      makeParams({
        memory: { "/": [{ fact: "macOS" }] },
        tools: { available: ["/usr/bin/git"], unavailable: ["docker"] },
      }),
    );
    const factsIdx = result.indexOf("## System facts");
    const toolsIdx = result.indexOf("## Detected tools");
    const cwdIdx = result.indexOf("Working directory");
    expect(factsIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(cwdIdx);
  });

  test("piped: true includes piped instruction", () => {
    const result = formatContext(makeParams({ piped: true }));
    expect(result).toContain("stdout is being piped");
    expect(result).toContain("bare value");
  });

  test("piped: false omits piped instruction", () => {
    const result = formatContext(makeParams({ piped: false }));
    expect(result).not.toContain("stdout is being piped");
  });

  test("piped defaults to false", () => {
    const result = formatContext(makeParams());
    expect(result).not.toContain("stdout is being piped");
  });

  test("piped instruction appears after tools and before cwd", () => {
    const result = formatContext(
      makeParams({ tools: { available: ["/usr/bin/git"], unavailable: [] }, piped: true }),
    );
    const toolsIdx = result.indexOf("## Detected tools");
    const pipedIdx = result.indexOf("stdout is being piped");
    const cwdIdx = result.indexOf("Working directory");
    expect(toolsIdx).toBeLessThan(pipedIdx);
    expect(pipedIdx).toBeLessThan(cwdIdx);
  });

  test("sections separated by double newlines", () => {
    const result = formatContext(
      makeParams({
        memory: { "/": [{ fact: "macOS" }] },
        tools: { available: ["/usr/bin/git"], unavailable: ["docker"] },
        piped: true,
      }),
    );
    expect(result).toContain("## System facts\n- macOS\n\n## Detected tools");
    expect(result).toContain("## Unavailable tools\ndocker\n\nstdout is being piped");
  });

  test("cwdFiles section included when provided", () => {
    const result = formatContext(makeParams({ cwdFiles: "package.json\nsrc/\nREADME.md" }));
    expect(result).toContain("## Files in CWD");
    expect(result).toContain("package.json\nsrc/\nREADME.md");
  });

  test("cwdFiles section omitted when not provided", () => {
    const result = formatContext(makeParams());
    expect(result).not.toContain("Files in CWD");
  });

  test("cwdFiles appears after piped and before cwd line", () => {
    const result = formatContext(
      makeParams({
        tools: { available: ["/usr/bin/git"], unavailable: [] },
        cwdFiles: "package.json",
        piped: true,
      }),
    );
    const pipedIdx = result.indexOf("stdout is being piped");
    const cwdFilesIdx = result.indexOf("## Files in CWD");
    const cwdIdx = result.indexOf("Working directory");
    expect(pipedIdx).toBeLessThan(cwdFilesIdx);
    expect(cwdFilesIdx).toBeLessThan(cwdIdx);
  });

  test("cwdFiles appears before cwd line", () => {
    const result = formatContext(makeParams({ cwdFiles: "package.json" }));
    const cwdFilesIdx = result.indexOf("## Files in CWD");
    const cwdIdx = result.indexOf("Working directory");
    expect(cwdFilesIdx).toBeLessThan(cwdIdx);
  });

  describe("attached input", () => {
    test("includes attached input section when preview is provided", () => {
      const result = formatContext(
        makeParams({
          attachedInputPath: "/tmp/wrap-scratch-abc/input",
          attachedInputSize: 16,
          attachedInputPreview: "some log content",
        }),
      );
      expect(result).toContain("## Attached input");
      expect(result).toContain("Path: /tmp/wrap-scratch-abc/input (16B)");
      expect(result).toContain("some log content");
    });

    test("attached input is the first section (before memory facts)", () => {
      const result = formatContext(
        makeParams({
          attachedInputPath: "/tmp/wrap-scratch-abc/input",
          attachedInputSize: 8,
          attachedInputPreview: "log data",
          memory: { "/": [{ fact: "macOS" }] },
        }),
      );
      const pipedIdx = result.indexOf("## Attached input");
      const factsIdx = result.indexOf("## System facts");
      expect(pipedIdx).toBeLessThan(factsIdx);
    });

    test("no attached input section when preview is undefined", () => {
      const result = formatContext(makeParams());
      expect(result).not.toContain("## Attached input");
    });

    test("emits 'Preview truncated' line when attachedInputTruncated is true", () => {
      const result = formatContext(
        makeParams({
          attachedInputPath: "/tmp/wrap-scratch-abc/input",
          attachedInputSize: 500,
          attachedInputPreview: "shortened preview",
          attachedInputTruncated: true,
        }),
      );
      expect(result).toContain("Preview truncated");
      expect(result).toContain("shortened preview");
    });

    test("no 'Preview truncated' line when attachedInputTruncated is false", () => {
      const result = formatContext(
        makeParams({
          attachedInputPath: "/tmp/wrap-scratch-abc/input",
          attachedInputSize: 13,
          attachedInputPreview: "short content",
          attachedInputTruncated: false,
        }),
      );
      expect(result).toContain("short content");
      expect(result).not.toContain("Preview truncated");
    });

    test("shows path line with size even without truncation", () => {
      const result = formatContext(
        makeParams({
          attachedInputPath: "/tmp/wrap-scratch-abc/input",
          attachedInputSize: 2048,
          attachedInputPreview: "content here",
        }),
      );
      expect(result).toContain("Path: /tmp/wrap-scratch-abc/input (2K)");
    });
  });
});
