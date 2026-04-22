import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetEditorCacheForTests,
  EDITORS,
  editorKey,
  resolveEditor,
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
    // Unknown → fallback meta (terminal-owning, no wait flag).
    expect(r?.meta.gui).toBeUndefined();
    expect(r?.meta.waitFlag).toBeUndefined();
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
