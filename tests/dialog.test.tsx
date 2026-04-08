import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { Dialog } from "../src/tui/dialog.tsx";

function extractDialogLines(frame: string): string[] {
  const lines = stripAnsi(frame).split("\n");
  const topIndex = lines.findIndex((line) => line.includes("╭"));
  if (topIndex === -1) return [];

  const bottomIndex = lines.findIndex((line, i) => i > topIndex && line.includes("╰"));
  if (bottomIndex === -1) return [];

  return lines.slice(topIndex, bottomIndex + 1).map((line) => line.trimStart());
}

describe("Dialog", () => {
  test("initial props are captured as state and ignored on re-render", () => {
    // The follow-up flow swaps command/risk/explanation in place without
    // remounting. The dialog holds them as local state seeded from initial*
    // props — re-rendering with new props after mount must NOT overwrite it.
    const { lastFrame, rerender } = render(
      <Dialog initialCommand="first" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("first");

    rerender(<Dialog initialCommand="second" initialRiskLevel="medium" onChoice={() => {}} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("first");
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("second");
  });

  test("renders command text", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="rm -rf /" initialRiskLevel="high" onChoice={() => {}} />,
    );
    expect(lastFrame()).toContain("rm -rf /");
  });

  test("renders risk badge in border", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="chmod 777 ." initialRiskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⚠ medium risk");
  });

  test("renders high risk badge", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="rm -rf /" initialRiskLevel="high" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⚠ high risk");
  });

  test("shows explanation when provided", () => {
    const { lastFrame } = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        initialExplanation="Deletes a file"
        onChoice={() => {}}
      />,
    );
    expect(lastFrame()).toContain("Deletes a file");
  });

  test("shows action bar with Run command prompt", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Run command?");
    expect(frame).toContain("Yes");
    expect(frame).toContain("No");
  });

  test("shows secondary actions in action bar", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Describe");
    expect(frame).toContain("Edit");
    expect(frame).toContain("Follow-up");
    expect(frame).toContain("Copy");
  });

  test("has gradient border corners", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("╭");
    expect(frame).toContain("╮");
    expect(frame).toContain("╰");
    expect(frame).toContain("╯");
  });

  test("has vertical border characters", () => {
    const { lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("│");
  });

  test("omits explanation line when not provided", () => {
    const withExplanation = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        initialExplanation="info"
        onChoice={() => {}}
      />,
    );
    const without = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    expect(stripAnsi(withExplanation.lastFrame() ?? "")).toContain("info");
    expect(stripAnsi(without.lastFrame() ?? "")).not.toContain("info");
  });

  test("keeps side borders aligned when explanation wraps", async () => {
    const { lastFrame } = render(
      <Dialog
        initialCommand="rm CLAUDE.md"
        initialRiskLevel="medium"
        initialExplanation="Deletes the file CLAUDE.md from the current directory (/Users/tal/mysite/wrap/.claude/worktrees/tui-plan). This is irreversible and removes it immediately."
        onChoice={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    const dialog = extractDialogLines(lastFrame() ?? "");
    const interior = dialog.slice(1, -1);
    expect(interior.length).toBeGreaterThan(0);
    expect(
      interior.every((line) => line === "" || (line.startsWith("│") && line.endsWith("│"))),
    ).toBe(true);
  });

  test("reflows on terminal resize without waiting for keyboard input", async () => {
    const app = render(
      <Dialog
        initialCommand="rm /Users/tal/mysite/wrap/CLAUDE.md"
        initialRiskLevel="high"
        initialExplanation="Deletes the CLAUDE.md file in your wrap project directory. This is irreversible and cannot be recovered unless you have git history or backup."
        onChoice={() => {}}
      />,
    );

    await new Promise((r) => setTimeout(r, 10));
    const before = stripAnsi(app.lastFrame() ?? "");
    const beforeDialog = extractDialogLines(before);

    Object.defineProperty(app.stdout, "columns", {
      value: 72,
      configurable: true,
    });
    app.stdout.emit("resize");

    await new Promise((r) => setTimeout(r, 10));
    const after = stripAnsi(app.lastFrame() ?? "");
    const afterDialog = extractDialogLines(after);
    const interior = afterDialog.slice(1, -1);

    expect(after).not.toBe(before);
    expect(afterDialog.length).toBeGreaterThan(0);
    expect(afterDialog[0]?.length).toBeLessThan(beforeDialog[0]?.length ?? 0);
    expect(interior.every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
  });

  test("keeps top border corners visible on narrow terminals", async () => {
    const app = render(
      <Dialog
        initialCommand="rm /Users/tal/mysite/wrap/CLAUDE.md"
        initialRiskLevel="high"
        initialExplanation="Deletes the CLAUDE.md file in your wrap project directory. This is irreversible and cannot be recovered unless you have git history or backup."
        onChoice={() => {}}
      />,
    );

    await new Promise((r) => setTimeout(r, 10));

    Object.defineProperty(app.stdout, "columns", { value: 50, configurable: true });
    app.stdout.emit("resize");

    await new Promise((r) => setTimeout(r, 20));
    const after = stripAnsi(app.lastFrame() ?? "");
    const dialog = extractDialogLines(after);
    const topLine = dialog[0] ?? "";

    expect(topLine.startsWith("╭")).toBe(true);
    expect(topLine.endsWith("╮")).toBe(true);
    expect(topLine.length).toBeLessThanOrEqual(50);
  });

  test("uses the latest width after rapid resize bursts", async () => {
    const app = render(
      <Dialog
        initialCommand="rm /Users/tal/mysite/wrap/CLAUDE.md"
        initialRiskLevel="high"
        initialExplanation="Deletes the CLAUDE.md file in your wrap project directory. This is irreversible and cannot be recovered unless you have git history or backup."
        onChoice={() => {}}
      />,
    );

    await new Promise((r) => setTimeout(r, 10));

    Object.defineProperty(app.stdout, "columns", { value: 88, configurable: true });
    app.stdout.emit("resize");
    Object.defineProperty(app.stdout, "columns", { value: 68, configurable: true });
    app.stdout.emit("resize");
    Object.defineProperty(app.stdout, "columns", { value: 76, configurable: true });
    app.stdout.emit("resize");

    await new Promise((r) => setTimeout(r, 20));

    const after = stripAnsi(app.lastFrame() ?? "");
    const dialog = extractDialogLines(after);
    const topLine = dialog[0] ?? "";

    expect(topLine.startsWith("╭")).toBe(true);
    expect(topLine.endsWith("╮")).toBe(true);
    expect(topLine.length).toBeLessThanOrEqual(72);
    expect(after).toContain("⚠ high risk");
  });
});

describe("Dialog — keybindings (both risk levels)", () => {
  test("y triggers run for medium risk", () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("y");
    expect(result).toBe("run");
  });

  test("y triggers run for high risk", () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm -rf /" initialRiskLevel="high" onChoice={(c) => (result = c)} />,
    );
    stdin.write("y");
    expect(result).toBe("run");
  });

  test("n triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("n");
    expect(result).toBe("cancel");
  });

  test("q triggers cancel", () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("q");
    expect(result).toBe("cancel");
  });

  test("Esc triggers cancel", async () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\x1b");
    // Ink's input parser uses a timeout to distinguish bare Esc from escape sequences
    await new Promise((r) => setTimeout(r, 100));
    expect(result).toBe("cancel");
  });

  test("d/f/c are no-ops (ignored in phase 1)", () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("d");
    stdin.write("f");
    stdin.write("c");
    expect(result).toBeUndefined();
    expect(lastFrame()).toContain("rm file");
  });

  test("ignores unrecognized keys", () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("x");
    stdin.write("a");
    expect(result).toBeUndefined();
    expect(lastFrame()).toContain("rm file");
  });

  test("Enter activates selected action (default: No = cancel)", () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("\r");
    expect(result).toBe("cancel");
  });

  test("arrow right then Enter activates Yes = run", async () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    // Move right to "Yes" — wait for React re-render before pressing Enter
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    expect(result).toBe("run");
  });

  test("y passes original command to onChoice", () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(_c, c) => (cmd = c)} />,
    );
    stdin.write("y");
    expect(cmd).toBe("rm file");
  });
});

describe("Dialog — edit mode", () => {
  test("e enters edit mode and shows run hint", async () => {
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⏎ to run");
  });

  test("edit mode shows the command text", async () => {
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("rm file");
  });

  test("in edit mode y/n/q do not trigger actions", async () => {
    let result: string | undefined;
    const { stdin } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("y");
    stdin.write("n");
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBeUndefined();
  });

  test("Enter in edit mode runs the command", async () => {
    let result: string | undefined;
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        onChoice={(c, command) => {
          result = c;
          cmd = command;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBe("run");
    expect(cmd).toBe("rm file");
  });

  test("Esc in edit mode returns to normal mode", async () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    expect(stripAnsi(lastFrame() ?? "")).toContain("⏎ to run");

    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));
    // Should be back to normal — Esc did not cancel the dialog
    expect(result).toBeUndefined();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Run command?");
  });

  test("after discarding edits, y runs original command", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        onChoice={(_c, command) => {
          cmd = command;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(" --force");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("y");
    expect(cmd).toBe("rm file");
  });

  test("empty command cannot be submitted", async () => {
    let result: string | undefined;
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="x" initialRiskLevel="medium" onChoice={(c) => (result = c)} />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\b"); // backspace to clear "x"
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(result).toBeUndefined();
    expect(lastFrame()).toBeDefined();
  });

  test("edited command is passed to onChoice on Enter", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        onChoice={(_c, command) => {
          cmd = command;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    // Append " --force" to the command
    stdin.write(" --force");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rm file --force");
  });

  test("action bar Edit button enters edit mode", async () => {
    const { stdin, lastFrame } = render(
      <Dialog initialCommand="rm file" initialRiskLevel="medium" onChoice={() => {}} />,
    );
    // Arrow right to Edit: No(0) → Yes(1) → Describe(2) → Edit(3)
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\x1b[C");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("⏎ to run");
  });

  test("Option+Left jumps to previous word boundary", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    // Option+Left: jump back one word from end
    stdin.write("\x1b\x1b[D");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rm /tmp/Xfile");
  });

  test("Option+Right jumps to end of current word", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    // Ctrl+A to go to start, then Option+Right lands at end of "rm"
    stdin.write("\x01");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b\x1b[C");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rmX /tmp/file");
  });

  test("Ctrl+A moves cursor to start", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x01"); // Ctrl+A
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("Xrm file");
  });

  test("Ctrl+E moves cursor to end", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x01"); // Ctrl+A to start
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x05"); // Ctrl+E to end
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("X");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rm fileX");
  });

  test("Ctrl+U deletes to start of line", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    // Option+Left to jump back one word ("file" → before "file")
    stdin.write("\x1b\x1b[D");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x15"); // Ctrl+U
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("file");
  });

  test("Ctrl+K deletes to end of line", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    // Ctrl+A to start, Option+Right lands at end of "rm" (offset 2), Ctrl+K kills rest
    stdin.write("\x01");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b\x1b[C"); // Option+Right to end of "rm"
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x0b"); // Ctrl+K
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rm");
  });

  test("Ctrl+Y yanks last killed text", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    // Kill to end from end of "rm"
    stdin.write("\x01"); // Ctrl+A
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b\x1b[C"); // Option+Right to end of "rm"
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x0b"); // Ctrl+K — kills " /tmp/file"
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x19"); // Ctrl+Y — yank it back
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rm /tmp/file");
  });

  test("Ctrl+U killed text can be yanked with Ctrl+Y", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x15"); // Ctrl+U — kills "rm /tmp/file"
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("echo ");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x19"); // Ctrl+Y — yank "rm /tmp/file"
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("echo rm /tmp/file");
  });

  test("Fn+Delete (forward delete) deletes char after cursor", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x01"); // Ctrl+A — move to start
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b[3~"); // Forward delete (Fn+Delete on Mac)
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b[3~"); // Delete another
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b[3~"); // Delete another
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("/tmp/file");
  });

  test("Option+Backspace deletes word left", async () => {
    let cmd: string | undefined;
    const { stdin } = render(
      <Dialog
        initialCommand="rm /tmp/file"
        initialRiskLevel="medium"
        onChoice={(_c, c) => {
          cmd = c;
        }}
      />,
    );
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b\x7f"); // Option+Delete (meta+delete)
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    expect(cmd).toBe("rm /tmp/");
  });
});

describe("showDialog", () => {
  const origIsTTY = process.stderr.isTTY;

  beforeAll(() => {
    // Force non-TTY so the TUI never opens (avoids SIGTTIN suspension
    // when tests run in a real terminal)
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
  });

  test("returns blocked when stderr is not a TTY", async () => {
    const { showDialog } = await import("../src/tui/render.ts");
    const result = await showDialog("rm -rf /", "high");
    expect(result.result).toBe("blocked");
    expect(result.command).toBe("rm -rf /");
  });
});
