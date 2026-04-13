import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import type { AppEvent } from "../src/session/state.ts";
import {
  formatOutputSlot,
  OUTPUT_SLOT_EMPTY,
  ResponseDialog,
  truncateCommand,
} from "../src/tui/response-dialog.tsx";
import {
  makeComposing,
  makeConfirming,
  makeEditing,
  makeExecutingStep,
  makeProcessing,
  makeResponse,
} from "./helpers/state-fixtures.ts";

function captureDispatch() {
  const events: AppEvent[] = [];
  return { dispatch: (e: AppEvent) => events.push(e), events };
}

async function tick() {
  await new Promise((r) => setTimeout(r, 30));
}

describe("Dialog — confirming", () => {
  test("renders the command from state.response.content", () => {
    const state = makeConfirming({
      response: makeResponse({ content: "ls -la", risk_level: "medium" }),
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("ls -la");
  });

  test("renders the explanation when present", () => {
    const state = makeConfirming({
      response: makeResponse({
        content: "rm a",
        explanation: "removes the file",
      }),
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("removes the file");
  });

  test("renders the action bar with hotkey hints", () => {
    const state = makeConfirming();
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Run command?");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
  });

  test("Enter dispatches key-action with currently-selected action", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\r");
    await tick();
    // Default selection is first item ("cancel").
    expect(events.some((e) => e.type === "key-action")).toBe(true);
  });

  test("hotkey y dispatches key-action run", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("y");
    await tick();
    expect(events).toContainEqual({ type: "key-action", action: "run" });
  });

  test("hotkey n dispatches key-action cancel", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("n");
    await tick();
    expect(events).toContainEqual({ type: "key-action", action: "cancel" });
  });

  test("hotkey e dispatches key-action edit", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("e");
    await tick();
    expect(events).toContainEqual({ type: "key-action", action: "edit" });
  });

  test("hotkey f dispatches key-action followup", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("f");
    await tick();
    expect(events).toContainEqual({ type: "key-action", action: "followup" });
  });

  test("Esc dispatches key-esc", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\u001b");
    await tick();
    expect(events.some((e) => e.type === "key-esc")).toBe(true);
  });

  test("q is an alias for cancel", async () => {
    const state = makeConfirming();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("q");
    await tick();
    expect(events).toContainEqual({ type: "key-action", action: "cancel" });
  });
});

describe("Dialog — editing", () => {
  test("renders the editable command from state.draft", () => {
    const state = makeEditing({
      response: makeResponse({ content: "rm a" }),
      draft: "rm -i a",
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("rm -i a");
  });

  test("typing dispatches draft-change", async () => {
    const state = makeEditing({
      response: makeResponse({ content: "rm" }),
      draft: "rm",
    });
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("x");
    await tick();
    expect(events.some((e) => e.type === "draft-change")).toBe(true);
  });

  test("Enter on editing dispatches submit-edit with the draft", async () => {
    const state = makeEditing({
      response: makeResponse({ content: "rm" }),
      draft: "rm -i",
    });
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\r");
    await tick();
    expect(events).toContainEqual({ type: "submit-edit", text: "rm -i" });
  });

  test("Enter on editing with blank draft does NOT dispatch submit-edit", async () => {
    const state = makeEditing({
      response: makeResponse({ content: "rm" }),
      draft: "   ",
    });
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\r");
    await tick();
    expect(events.find((e) => e.type === "submit-edit")).toBeUndefined();
  });

  test("Esc dispatches key-esc", async () => {
    const state = makeEditing();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\u001b");
    await tick();
    expect(events).toContainEqual({ type: "key-esc" });
  });
});

describe("Dialog — composing", () => {
  test("typing dispatches draft-change", async () => {
    const state = makeComposing({ draft: "" });
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("x");
    await tick();
    expect(events.some((e) => e.type === "draft-change")).toBe(true);
  });

  test("Enter dispatches submit-followup with the draft", async () => {
    const state = makeComposing({ draft: "be safer" });
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\r");
    await tick();
    expect(events).toContainEqual({ type: "submit-followup", text: "be safer" });
  });

  test("Enter on composing with blank draft does NOT dispatch submit-followup", async () => {
    const state = makeComposing({ draft: "  " });
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\r");
    await tick();
    expect(events.find((e) => e.type === "submit-followup")).toBeUndefined();
  });

  test("Esc dispatches key-esc", async () => {
    const state = makeComposing();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\u001b");
    await tick();
    expect(events).toContainEqual({ type: "key-esc" });
  });

  test("renders the placeholder when draft is empty", () => {
    const state = makeComposing({ draft: "" });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("actually...");
  });
});

describe("Dialog — processing", () => {
  test("renders the draft as read-only", () => {
    const state = makeProcessing({ draft: "the draft" });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("the draft");
  });

  test("renders state.status in the bottom border when set", () => {
    const state = makeProcessing({ status: "Probing the database" });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("Probing the database");
  });

  test("Esc dispatches key-esc", async () => {
    const state = makeProcessing();
    const { dispatch, events } = captureDispatch();
    const { stdin } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    stdin.write("\u001b");
    await tick();
    expect(events).toContainEqual({ type: "key-esc" });
  });
});

describe("Dialog — rerender behaviour", () => {
  test("rerender swaps the displayed command without remounting", async () => {
    // Mount in confirming, then rerender with a different command. The
    // displayed text should reflect the new command after the rerender
    // (the read-only TextInput pulls directly from the prop, so no
    // local-cursor-effect dance is needed).
    const state1 = makeConfirming({ response: makeResponse({ content: "first cmd" }) });
    const state2 = makeConfirming({
      response: makeResponse({ content: "second cmd" }),
    });
    const { dispatch } = captureDispatch();
    const { rerender, lastFrame } = render(<ResponseDialog state={state1} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("first cmd");
    rerender(<ResponseDialog state={state2} dispatch={dispatch} />);
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("second cmd");
  });
});

describe("formatOutputSlot", () => {
  test("returns the empty sentinel for blank output", () => {
    expect(formatOutputSlot("")).toBe(OUTPUT_SLOT_EMPTY);
    expect(formatOutputSlot("   \n  \n")).toBe(OUTPUT_SLOT_EMPTY);
  });

  test("returns the body as-is when it fits the tail window", () => {
    expect(formatOutputSlot("a\nb\nc")).toBe("a\nb\nc");
    expect(formatOutputSlot("only one line")).toBe("only one line");
  });

  test("tails to the last 3 rows when output is longer", () => {
    const out = formatOutputSlot("1\n2\n3\n4\n5\n");
    expect(out).toBe("3\n4\n5");
  });
});

describe("truncateCommand", () => {
  test("returns short command unchanged", () => {
    expect(truncateCommand("ls -la", 10, 80)).toBe("ls -la");
  });

  test("returns multi-line command unchanged when it fits", () => {
    const cmd = "echo a\necho b\necho c";
    expect(truncateCommand(cmd, 10, 80)).toBe(cmd);
  });

  test("truncates when lines exceed maxRows", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `echo line${i}`);
    const cmd = lines.join("\n");
    const result = truncateCommand(cmd, 10, 80);
    expect(result).toContain("echo line0");
    expect(result).toContain("echo line29");
    expect(result).toContain("lines hidden");
    expect(result).not.toContain("hidden hidden");
    const resultLines = result.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(10);
  });

  test("accounts for soft-wrapping of long single lines", () => {
    // A single line of 200 chars at width 40 wraps to 5 visual rows.
    const cmd = "x".repeat(200);
    const result = truncateCommand(cmd, 3, 40);
    // Single line exceeds budget — can't split it, so indicator is all we get.
    expect(result).not.toBe(cmd);
    expect(result).toContain("lines hidden");
  });

  test("handles mixed long and short lines", () => {
    const lines = [
      "a".repeat(100), // wraps to 2 rows at width 50
      "short",
      "b".repeat(100),
      "also short",
      "c".repeat(100),
      "end",
    ];
    const cmd = lines.join("\n");
    const result = truncateCommand(cmd, 4, 50);
    expect(result).toContain("end");
    const visualRows = result.split("\n").reduce((sum: number, line: string) => {
      return sum + Math.max(1, Math.ceil(line.length / 50));
    }, 0);
    expect(visualRows).toBeLessThanOrEqual(4);
  });

  test("returns command as-is when maxRows is very large", () => {
    const cmd = "echo a\necho b\necho c";
    expect(truncateCommand(cmd, 1000, 80)).toBe(cmd);
  });

  test("returns command as-is when textWidth is zero or negative", () => {
    const cmd = "echo a\necho b";
    expect(truncateCommand(cmd, 5, 0)).toBe(cmd);
    expect(truncateCommand(cmd, 5, -1)).toBe(cmd);
  });
});

describe("Dialog — multi-step slots", () => {
  test("renders the output slot when set", () => {
    const state = makeConfirming({
      response: makeResponse({ content: "echo done" }),
      outputSlot: "discovered sips at /usr/bin/sips",
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Output:");
    expect(text).toContain("discovered sips");
  });

  test("renders (no output) sentinel for an empty step body", () => {
    const state = makeConfirming({
      response: makeResponse({ content: "echo done" }),
      outputSlot: "",
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain(OUTPUT_SLOT_EMPTY);
  });

  test("omits the output slot entirely before any step has run", () => {
    const state = makeConfirming({
      response: makeResponse({ content: "echo done" }),
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("Output:");
  });

  test("renders the plan slot when response.plan is present", () => {
    const state = makeConfirming({
      response: makeResponse({
        content: "bash $WRAP_TEMP_DIR/install.sh",
        final: false,
        risk_level: "medium",
        plan: "Download, inspect, then run the exact bytes we read.",
      }),
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("Plan:");
    expect(text).toContain("Download, inspect");
  });

  test("executing-step renders the command, output slot, and abort hint", () => {
    const state = makeExecutingStep({
      response: makeResponse({
        content: "git stash",
        final: false,
        risk_level: "medium",
      }),
      outputSlot: "Saved working directory.",
    });
    const { dispatch } = captureDispatch();
    const { lastFrame } = render(<ResponseDialog state={state} dispatch={dispatch} />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("git stash");
    expect(text).toContain("Saved working directory.");
    expect(text).toContain("abort step");
  });
});
