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

  test("tools section included when toolsOutput provided", () => {
    const result = formatContext(makeParams({ toolsOutput: "/usr/bin/git\ndocker not found" }));
    expect(result).toContain("## Detected tools");
    expect(result).toContain("/usr/bin/git");
    expect(result).toContain("docker not found");
  });

  test("tools section omitted when toolsOutput not provided", () => {
    const result = formatContext(makeParams());
    expect(result).not.toContain("Detected tools");
  });

  test("tools section appears after memory and before cwd", () => {
    const result = formatContext(
      makeParams({
        memory: { "/": [{ fact: "macOS" }] },
        toolsOutput: "/usr/bin/git",
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
    const result = formatContext(makeParams({ toolsOutput: "/usr/bin/git", piped: true }));
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
        toolsOutput: "/usr/bin/git",
        piped: true,
      }),
    );
    expect(result).toContain("## System facts\n- macOS\n\n## Detected tools");
    expect(result).toContain("/usr/bin/git\n\nstdout is being piped");
  });
});
