import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetEditorCacheForTests,
  EDITORS,
  editorKey,
  type ResolvedEditor,
  resolveEditor,
  spawnEditor,
} from "../src/core/editor.ts";

beforeEach(() => {
  _resetEditorCacheForTests();
});

describe("editorKey", () => {
  test("strips directory and .exe suffix", () => {
    expect(editorKey("/usr/local/bin/code")).toBe("code");
    expect(editorKey("C:\\Program Files\\Notepad\\notepad.exe")).toBe("notepad");
  });

  test("bare basename passes through", () => {
    expect(editorKey("vim")).toBe("vim");
  });

  test(".exe suffix stripped only at end (so foo.exe.bak keeps .bak)", () => {
    expect(editorKey("/usr/bin/code.exe.bak")).toBe("code.exe.bak");
  });

  test("windows-style backslash path on POSIX collapses to basename", () => {
    // Addresses the JSDoc contract about Windows paths running on POSIX.
    expect(editorKey("\\vim")).toBe("vim");
    expect(editorKey("C:\\Apps\\nano.exe")).toBe("nano");
  });
});

describe("EDITORS record", () => {
  test("GUI editors all carry a wait flag", () => {
    for (const [key, meta] of Object.entries(EDITORS)) {
      if (meta.gui) {
        expect(meta.waitFlag).toBeDefined();
        expect(meta.waitFlag, key).not.toBe("");
      }
    }
  });

  test("terminal-owning editors do NOT carry a wait flag", () => {
    for (const meta of Object.values(EDITORS)) {
      if (!meta.gui) expect(meta.waitFlag).toBeUndefined();
    }
  });

  test("every entry has a displayName", () => {
    for (const meta of Object.values(EDITORS)) {
      expect(meta.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveEditor", () => {
  test("$VISUAL wins over $EDITOR and EDITORS sweep", () => {
    const which = (cmd: string) => (cmd === "code" ? "/usr/local/bin/code" : null);
    const r = resolveEditor({ envVisual: "code", envEditor: "nano", which });
    expect(r?.key).toBe("code");
    expect(r?.meta.displayName).toBe("VS Code");
  });

  test("$EDITOR used when $VISUAL unset", () => {
    const which = (cmd: string) => (cmd === "vim" ? "/usr/bin/vim" : null);
    const r = resolveEditor({ envVisual: "", envEditor: "vim", which });
    expect(r?.key).toBe("vim");
    expect(r?.meta.gui).toBeUndefined();
  });

  test("env editor with bare command + no which hit still resolves (bare path passes through)", () => {
    // $EDITOR="my-custom-editor" but it's not on PATH — we keep the bare name
    // so the caller at least surfaces something in the hint bar.
    const which = () => null;
    const r = resolveEditor({ envVisual: "", envEditor: "my-custom-editor", which });
    expect(r?.key).toBe("my-custom-editor");
    // Unknown → fallback meta (terminal-owning, no wait flag) with displayName=key.
    expect(r?.meta.gui).toBeUndefined();
    expect(r?.meta.waitFlag).toBeUndefined();
    expect(r?.meta.displayName).toBe("my-custom-editor");
  });

  test("$VISUAL is trimmed of surrounding whitespace before lookup", () => {
    const which = (cmd: string) => (cmd === "vim" ? "/usr/bin/vim" : null);
    const r = resolveEditor({ envVisual: "  vim  ", envEditor: "", which });
    expect(r?.key).toBe("vim");
  });

  test("$EDITOR is trimmed of surrounding whitespace before lookup", () => {
    const which = (cmd: string) => (cmd === "nano" ? "/bin/nano" : null);
    const r = resolveEditor({ envVisual: "", envEditor: "  nano\n", which });
    expect(r?.key).toBe("nano");
  });

  test("no env override: sweeps EDITORS in declaration order, short-circuits on hit", () => {
    const calls: string[] = [];
    const which = (cmd: string) => {
      calls.push(cmd);
      // Simulate only `nano` available on PATH.
      return cmd === "nano" ? "/bin/nano" : null;
    };
    const r = resolveEditor({ envVisual: "", envEditor: "", which });
    expect(r?.key).toBe("nano");
    // Short-circuits after nano — should not have continued past.
    const afterNano = calls.indexOf("nano");
    expect(afterNano).toBeGreaterThanOrEqual(0);
    expect(calls.slice(afterNano + 1)).toEqual([]);
  });

  test("nothing on PATH → null", () => {
    const r = resolveEditor({ envVisual: "", envEditor: "", which: () => null });
    expect(r).toBeNull();
  });

  test("cache: second call returns the same object without re-probing", () => {
    let probes = 0;
    const which = (cmd: string) => {
      probes++;
      return cmd === "vim" ? "/usr/bin/vim" : null;
    };
    const first = resolveEditor({ envVisual: "", envEditor: "", which });
    const probesAfterFirst = probes;
    const second = resolveEditor({ envVisual: "", envEditor: "", which });
    expect(second).toBe(first);
    expect(probes).toBe(probesAfterFirst);
  });

  test("VS Code absolute path in $EDITOR is recognized as GUI", () => {
    const which = (cmd: string) =>
      cmd === "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ? cmd : null;
    const r = resolveEditor({
      envVisual: "",
      envEditor: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      which,
    });
    expect(r?.key).toBe("code");
    expect(r?.meta.gui).toBe(true);
    expect(r?.meta.waitFlag).toBe("-w");
  });
});

describe("spawnEditor", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wrap-editor-spawn-"));
    prevHome = process.env.WRAP_HOME;
    process.env.WRAP_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.WRAP_HOME;
    else process.env.WRAP_HOME = prevHome;
  });

  let seq = 0;
  function makeFakeEditor(script: string): string {
    seq++;
    const path = join(home, `fake-${seq}.sh`);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
  }

  function terminalMeta(path: string): ResolvedEditor {
    return { path, key: "fake", meta: { displayName: "Fake" } };
  }

  test("happy path: editor rewrites buffer; trailing \\n stripped", async () => {
    const editor = makeFakeEditor(`#!/bin/sh\nprintf 'new buffer\\n' > "$1"\n`);
    const r = await spawnEditor(terminalMeta(editor), "seed");
    expect(r).toBe("new buffer");
  });

  test("editor leaves file untouched → returns the seed draft (zero exit, non-empty)", async () => {
    // Terminal editor quits without writing — compose.md still has the seed.
    const editor = makeFakeEditor(`#!/bin/sh\nexit 0\n`);
    const r = await spawnEditor(terminalMeta(editor), "seed text");
    expect(r).toBe("seed text");
  });

  test("empty file after edit → returns null", async () => {
    const editor = makeFakeEditor(`#!/bin/sh\n: > "$1"\n`);
    const r = await spawnEditor(terminalMeta(editor), "seed");
    expect(r).toBeNull();
  });

  test("non-zero exit code → returns null, buffer kept", async () => {
    const editor = makeFakeEditor(`#!/bin/sh\nprintf 'ignored' > "$1"\nexit 2\n`);
    const r = await spawnEditor(terminalMeta(editor), "seed");
    expect(r).toBeNull();
  });

  test("non-existent editor path → catch returns null", async () => {
    const r = await spawnEditor(terminalMeta("/nonexistent/xyz-not-an-editor"), "seed");
    expect(r).toBeNull();
  });

  test("wait flag is passed through argv for GUI editors", async () => {
    // Script exits 3 if $1 isn't the wait flag, so a missing/wrong flag → null.
    const editor = makeFakeEditor(
      `#!/bin/sh\n[ "$1" = "-w" ] || exit 3\nprintf 'gui edit' > "$2"\n`,
    );
    const r = await spawnEditor(
      { path: editor, key: "code", meta: { displayName: "VS Code", waitFlag: "-w", gui: true } },
      "seed",
    );
    expect(r).toBe("gui edit");
  });

  test("pre-aborted signal → returns null without waiting", async () => {
    const editor = makeFakeEditor(`#!/bin/sh\nsleep 10\n`);
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    const r = await spawnEditor(terminalMeta(editor), "seed", ctrl.signal);
    expect(r).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("abort during wait → returns null", async () => {
    const editor = makeFakeEditor(`#!/bin/sh\nsleep 5\n`);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const r = await spawnEditor(terminalMeta(editor), "seed", ctrl.signal);
    expect(r).toBeNull();
  });

  test("seed draft is written to compose.md before editor runs", async () => {
    // The fake editor copies the file's current contents out to a sibling,
    // then asserts the seed round-trips. Demonstrates writeFileSync(filePath, draft).
    const sentinel = join(home, "seen-seed.txt");
    const editor = makeFakeEditor(`#!/bin/sh\ncat "$1" > "${sentinel}"\nprintf 'done' > "$1"\n`);
    const r = await spawnEditor(terminalMeta(editor), "initial draft\nline 2");
    expect(r).toBe("done");
    expect(readFileSync(sentinel, "utf-8")).toBe("initial draft\nline 2");
  });
});
