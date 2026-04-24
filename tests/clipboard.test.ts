import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetClipboardCacheForTests,
  CLIPBOARD_TOOLS,
  copyToClipboard,
  resolveClipboardTool,
} from "../src/core/clipboard.ts";

beforeEach(() => {
  _resetClipboardCacheForTests();
});

type SpawnCall = {
  argv: readonly string[];
  options: Parameters<typeof Bun.spawn>[1];
};

function makeFakeSpawn(calls: SpawnCall[], { throws = false } = {}) {
  let unrefCalls = 0;
  const stdinWrites: string[] = [];
  let stdinEnded = 0;
  const fake = ((argv: readonly string[], options: Parameters<typeof Bun.spawn>[1]) => {
    calls.push({ argv, options });
    if (throws) throw new Error("spawn failed");
    return {
      stdin: {
        write(chunk: string) {
          stdinWrites.push(chunk);
          return chunk.length;
        },
        end() {
          stdinEnded++;
          return 0;
        },
      },
      unref() {
        unrefCalls++;
      },
    };
  }) as unknown as typeof Bun.spawn;
  return {
    spawn: fake,
    get unrefCalls() {
      return unrefCalls;
    },
    get stdinWrites() {
      return stdinWrites;
    },
    get stdinEnded() {
      return stdinEnded;
    },
  };
}

describe("resolveClipboardTool", () => {
  test("returns the first available tool in declared order", () => {
    const which = (cmd: string) => (cmd === "xclip" || cmd === "pbcopy" ? `/usr/bin/${cmd}` : null);
    expect(resolveClipboardTool({ which })).toBe("xclip");
  });

  test("returns null when no candidate is on PATH", () => {
    expect(resolveClipboardTool({ which: () => null })).toBeNull();
  });

  test("caches the first result for the process lifetime", () => {
    const calls: string[] = [];
    const which = (cmd: string) => {
      calls.push(cmd);
      return cmd === "pbcopy" ? "/usr/bin/pbcopy" : null;
    };
    expect(resolveClipboardTool({ which })).toBe("pbcopy");
    // Passing a different which on the second call must not re-probe.
    const which2 = (cmd: string) => (cmd === "xclip" ? "/usr/bin/xclip" : null);
    expect(resolveClipboardTool({ which: which2 })).toBe("pbcopy");
  });
});

describe("copyToClipboard", () => {
  test("no-ops when resolver returns null", () => {
    const calls: SpawnCall[] = [];
    const fake = makeFakeSpawn(calls);
    copyToClipboard("hello", { which: () => null, spawn: fake.spawn });
    expect(calls.length).toBe(0);
  });

  test("strips a single trailing newline before writing", () => {
    const calls: SpawnCall[] = [];
    const fake = makeFakeSpawn(calls);
    copyToClipboard("ls -la\n", {
      which: (cmd) => (cmd === "pbcopy" ? "/usr/bin/pbcopy" : null),
      spawn: fake.spawn,
    });
    expect(fake.stdinWrites).toEqual(["ls -la"]);
    expect(fake.stdinEnded).toBe(1);
  });

  test("spawns with piped stdin, ignored stdout/stderr, and unrefs immediately", () => {
    const calls: SpawnCall[] = [];
    const fake = makeFakeSpawn(calls);
    copyToClipboard("data", {
      which: (cmd) => (cmd === "xclip" ? "/usr/bin/xclip" : null),
      spawn: fake.spawn,
    });
    expect(calls.length).toBe(1);
    const [call] = calls;
    expect(call?.argv).toEqual(["xclip", "-selection", "clipboard"]);
    expect(call?.options).toMatchObject({
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(fake.unrefCalls).toBe(1);
  });

  test("passes the per-tool argv for each supported binary", () => {
    const expected: Record<(typeof CLIPBOARD_TOOLS)[number], readonly string[]> = {
      "wl-copy": ["wl-copy"],
      xclip: ["xclip", "-selection", "clipboard"],
      xsel: ["xsel", "-ib"],
      pbcopy: ["pbcopy"],
      "clip.exe": ["clip.exe"],
    };
    for (const tool of CLIPBOARD_TOOLS) {
      _resetClipboardCacheForTests();
      const calls: SpawnCall[] = [];
      const fake = makeFakeSpawn(calls);
      copyToClipboard("x", {
        which: (cmd) => (cmd === tool ? `/usr/bin/${tool}` : null),
        spawn: fake.spawn,
      });
      expect(calls[0]?.argv).toEqual(expected[tool]);
    }
  });

  test("swallows async rejections from stdin.write / stdin.end", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const rejectingSpawn = ((_argv: readonly string[], _opts: unknown) => ({
        stdin: {
          write: () => Promise.reject(new Error("write failed")),
          end: () => Promise.reject(new Error("end failed")),
        },
        unref() {},
      })) as unknown as typeof Bun.spawn;
      copyToClipboard("x", {
        which: (cmd) => (cmd === "pbcopy" ? "/usr/bin/pbcopy" : null),
        spawn: rejectingSpawn,
      });
      // Let microtasks flush.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("swallows synchronous throws from spawn", () => {
    const calls: SpawnCall[] = [];
    const fake = makeFakeSpawn(calls, { throws: true });
    expect(() =>
      copyToClipboard("x", {
        which: (cmd) => (cmd === "pbcopy" ? "/usr/bin/pbcopy" : null),
        spawn: fake.spawn,
      }),
    ).not.toThrow();
  });
});
