import { afterEach, describe, expect, test } from "bun:test";
import { interceptOutput, resetOutputSink, writeLine } from "../src/core/output-sink.ts";

const originalStderrWrite = process.stderr.write;
let captured = "";

function captureStderr() {
  captured = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  };
}

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  resetOutputSink();
});

describe("writeLine with no interception active", () => {
  test("writes line straight to stderr regardless of chrome event presence", () => {
    captureStderr();
    writeLine("hello\n");
    writeLine("🔍 hi\n", { text: "hi", icon: "🔍" });
    expect(captured).toBe("hello\n🔍 hi\n");
  });
});

describe("interceptOutput", () => {
  test("buffers lines and fans out chrome events to the handler", () => {
    const events: Array<{ text: string; icon?: string }> = [];
    const release = interceptOutput((e) => {
      events.push({ text: e.text, icon: e.icon });
    });
    captureStderr();
    writeLine("🔍 hi\n", { text: "hi", icon: "🔍" });
    expect(captured).toBe("");
    expect(events).toEqual([{ text: "hi", icon: "🔍" }]);
    release();
  });

  test("verbose lines (no chromeEvent) are buffered for replay but never reach the handler", () => {
    let calls = 0;
    const release = interceptOutput(() => {
      calls += 1;
    });
    writeLine("» verbose line\n");
    expect(calls).toBe(0);
    captureStderr();
    release();
    expect(captured).toBe("» verbose line\n");
  });

  test("release flushes pending lines to stderr in original order", () => {
    const release = interceptOutput(() => {});
    writeLine("a\n", { text: "a" });
    writeLine("» b\n");
    writeLine("🧠 c\n", { text: "c", icon: "🧠" });
    captureStderr();
    release();
    expect(captured).toBe("a\n» b\n🧠 c\n");
  });

  test("writes after release go straight to stderr", () => {
    const release = interceptOutput(() => {});
    release();
    captureStderr();
    writeLine("after\n", { text: "after" });
    expect(captured).toBe("after\n");
  });

  test("handler is not called after release", () => {
    let calls = 0;
    const release = interceptOutput(() => {
      calls += 1;
    });
    release();
    captureStderr();
    writeLine("post\n", { text: "post" });
    expect(calls).toBe(0);
    expect(captured).toBe("post\n");
  });

  test("handler without icon receives undefined for that field", () => {
    let receivedIcon: string | undefined = "untouched";
    const release = interceptOutput((e) => {
      receivedIcon = e.icon;
    });
    captureStderr();
    writeLine("plain\n", { text: "plain" });
    expect(receivedIcon).toBeUndefined();
    release();
  });

  test("intercepting twice throws so leftover buffers can't be silently dropped", () => {
    const release = interceptOutput(() => {});
    expect(() => interceptOutput(() => {})).toThrow(/already active/);
    release();
  });

  test("releasing twice throws to surface programmer errors", () => {
    const release = interceptOutput(() => {});
    release();
    expect(() => release()).toThrow(/release called twice/);
  });

  test("handler exceptions are swallowed and the line is still buffered for replay", () => {
    const release = interceptOutput(() => {
      throw new Error("boom");
    });
    expect(() => {
      writeLine("x\n", { text: "x" });
    }).not.toThrow();
    captureStderr();
    release();
    expect(captured).toBe("x\n");
  });
});
