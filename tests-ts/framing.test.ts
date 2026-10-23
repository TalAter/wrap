import { describe, expect, test } from "bun:test";
import type { CommandResponse } from "../src/command-response.schema.ts";
import {
  createTurnFramer,
  formatCommandEcho,
  projectResponseForEcho,
  type Transcript,
} from "../src/llm/framing.ts";
import promptConstants from "../src/prompt.constants.json";

const cmdResponse: CommandResponse = {
  type: "command",
  final: true,
  content: "ls -la",
  risk_level: "medium",
};

const stepResponse: CommandResponse = {
  type: "command",
  final: false,
  content: "uname",
  risk_level: "low",
};

const answerResponse: CommandResponse = {
  type: "reply",
  final: true,
  content: "the answer",
  risk_level: "low",
};

/** Frame a whole transcript through one stateful framer. */
function frameAll(transcript: Transcript, framing?: Parameters<typeof createTurnFramer>[0]) {
  const framer = createTurnFramer(framing);
  return transcript.flatMap((t) => framer.frame(t));
}

describe("createTurnFramer — turn kinds", () => {
  test("user turn renders bare without framing", () => {
    const out = frameAll([{ kind: "user", text: "hi" }]);
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  test("user + assistant + step turns render in order", () => {
    const out = frameAll([
      { kind: "user", text: "hi" },
      { kind: "assistant", response: stepResponse, attempts: [], source: "model" },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "out1",
        shell: "/bin/sh",
        source: "model",
      },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: JSON.stringify(projectResponseForEcho(stepResponse)),
    });
    expect(out[2]).toEqual({
      role: "user",
      content: `${promptConstants.sectionCapturedOutput}\nout1`,
    });
  });

  test("assistant turn for a reply renders as projected JSON", () => {
    const out = frameAll([
      { kind: "assistant", response: answerResponse, attempts: [], source: "model" },
    ]);
    expect(out).toEqual([
      { role: "assistant", content: JSON.stringify(projectResponseForEcho(answerResponse)) },
    ]);
  });

  test("assistant turn with no response (fully-failed round) frames to nothing", () => {
    const out = frameAll([
      { kind: "user", text: "hi" },
      {
        kind: "assistant",
        attempts: [{ error: { kind: "provider", message: "rate limit" } }],
        source: "model",
      },
      { kind: "user", text: "retry" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "retry" },
    ]);
  });

  test("step with empty output renders the capturedNoOutput sentinel", () => {
    const out = frameAll([
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "",
        shell: "/bin/sh",
        source: "model",
      },
    ]);
    expect(out[0]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("step with whitespace-only output and exit 0 renders the no-output sentinel", () => {
    const out = frameAll([
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "  \n  ",
        shell: "/bin/sh",
        source: "model",
      },
    ]);
    expect(out[0]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });

  test("step output with trailing newline is trimmed in render", () => {
    const out = frameAll([
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "hi\n",
        shell: "/bin/sh",
        source: "model",
      },
    ]);
    expect(out[0]?.content).toBe(`${promptConstants.sectionCapturedOutput}\nhi`);
  });

  test("step output with non-zero exit code includes the exit code", () => {
    const out = frameAll([
      {
        kind: "step",
        command: "uname",
        exit_code: 2,
        output: "boom",
        shell: "/bin/sh",
        source: "model",
      },
    ]);
    expect(out[0]?.content).toContain("Exit code: 2");
  });

  test("user_override step renders identically to model-source step", () => {
    const mk = (source: "model" | "user_override") =>
      frameAll([
        {
          kind: "step",
          command: "echo git-stash-fake",
          exit_code: 0,
          output: "Saved working directory.",
          shell: "/bin/sh",
          source,
        },
      ]);
    expect(mk("user_override")).toEqual(mk("model"));
  });

  test("probe turn expands to the same pair as a model-sourced assistant+step", () => {
    const fromPair = frameAll([
      { kind: "user", text: "hi" },
      { kind: "assistant", response: stepResponse, attempts: [], source: "model" },
      {
        kind: "step",
        command: "uname",
        exit_code: 0,
        output: "Linux",
        shell: "/bin/sh",
        source: "model",
      },
    ]);
    const fromProbe = frameAll([
      { kind: "user", text: "hi" },
      { kind: "probe", skill: "discovery", command: "uname", output: "Linux" },
    ]);
    expect(fromProbe).toEqual(fromPair);
  });

  test("probe turn with empty output uses the no-output sentinel", () => {
    const out = frameAll([{ kind: "probe", skill: "discovery", command: "pwd", output: "" }]);
    expect(out[1]?.content).toBe(
      `${promptConstants.sectionCapturedOutput}\n${promptConstants.capturedNoOutput}`,
    );
  });
});

describe("createTurnFramer — request framing", () => {
  const framing = { contextString: "ctx-here", sectionUserRequest: "## User's request" };

  test("wraps only the FIRST user turn", () => {
    const out = frameAll(
      [
        { kind: "user", text: "first" },
        { kind: "assistant", response: cmdResponse, attempts: [], source: "model" },
        { kind: "user", text: "second" },
      ],
      framing,
    );
    expect(out[0]?.content).toBe("ctx-here\n\n## User's request\nfirst");
    expect(out[2]?.content).toBe("second");
  });

  test("empty contextString omits the leading separator", () => {
    const out = frameAll([{ kind: "user", text: "go" }], {
      contextString: "",
      sectionUserRequest: "## User's request",
    });
    expect(out[0]?.content).toBe("## User's request\ngo");
  });

  test("probe turn is not treated as a user turn for framing", () => {
    const out = frameAll(
      [
        { kind: "probe", skill: "discovery", command: "pwd", output: "/home" },
        { kind: "user", text: "list files" },
      ],
      { contextString: "ctx", sectionUserRequest: "## User's request" },
    );
    expect(out[2]?.content).toBe("ctx\n\n## User's request\nlist files");
  });

  test("step-projected user messages do not consume the framing", () => {
    const out = frameAll(
      [
        {
          kind: "step",
          command: "which ffmpeg",
          exit_code: 0,
          output: "/opt/homebrew/bin/ffmpeg",
          shell: "/bin/sh",
          source: "model",
        },
        { kind: "user", text: "list files" },
      ],
      framing,
    );
    expect(out[1]?.content).toBe("ctx-here\n\n## User's request\nlist files");
  });

  test("statefulness spans frame() calls — follow-up user turns are bare", () => {
    const framer = createTurnFramer(framing);
    const first = framer.frame({ kind: "user", text: "first" });
    const second = framer.frame({ kind: "user", text: "later follow-up" });
    expect(first[0]?.content).toContain("## User's request\nfirst");
    expect(second[0]?.content).toBe("later follow-up");
  });

  test("framing is consumed exactly once — third user turn stays bare too", () => {
    const framer = createTurnFramer(framing);
    framer.frame({ kind: "user", text: "first" });
    framer.frame({ kind: "user", text: "second" });
    const third = framer.frame({ kind: "user", text: "third" });
    expect(third[0]?.content).toBe("third");
  });
});

describe("createTurnFramer — final turns (continuation re-adds)", () => {
  test("model-source final projects as a <wrap-note> user message", () => {
    const out = frameAll([
      {
        kind: "final",
        command: "git push heroku main",
        exit_code: 0,
        shell: "/bin/sh",
        source: "model",
        exec_ms: 10,
      },
    ]);
    expect(out).toEqual([
      { role: "user", content: "<wrap-note>\nprevious command exited 0\n</wrap-note>" },
    ]);
  });

  test("cancelled source includes the proposed command", () => {
    const out = frameAll([
      { kind: "final", command: "git push heroku main", exit_code: null, source: "cancelled" },
    ]);
    expect(out[0]?.content).toContain("user cancelled the previous command");
    expect(out[0]?.content).toContain("git push heroku main");
  });

  test("user_override echoes executed bytes and exit code", () => {
    const out = frameAll([
      {
        kind: "final",
        command: "cat <<EOF > foo.txt\nhello\nEOF",
        exit_code: 0,
        shell: "/bin/sh",
        source: "user_override",
        exec_ms: 5,
      },
    ]);
    expect(out[0]?.content).toContain("user ran the following instead of the proposal; exited 0");
    expect(out[0]?.content).toContain("cat <<EOF > foo.txt");
  });

  test("blocked source emits a short generic note", () => {
    const out = frameAll([
      { kind: "final", command: "rm -rf /", exit_code: null, source: "blocked" },
    ]);
    expect(out[0]?.content).toBe("<wrap-note>\nprevious command was blocked\n</wrap-note>");
  });

  test("exhausted source includes the last proposed command", () => {
    const out = frameAll([
      { kind: "final", command: "git push heroku main", exit_code: null, source: "exhausted" },
    ]);
    expect(out[0]?.content).toContain("hit the round budget");
    expect(out[0]?.content).toContain("git push heroku main");
  });

  test("exhausted with no proposal emits the short variant", () => {
    const out = frameAll([{ kind: "final", command: "", exit_code: null, source: "exhausted" }]);
    expect(out[0]?.content).toBe(
      "<wrap-note>\nprevious run hit the round budget without completing\n</wrap-note>",
    );
  });

  test("error source emits a generic error note", () => {
    const out = frameAll([
      { kind: "final", command: "anything", exit_code: null, source: "error" },
    ]);
    expect(out[0]?.content).toBe(
      "<wrap-note>\nprevious run ended in an error before completing\n</wrap-note>",
    );
  });
});

describe("projectResponseForEcho", () => {
  test("strips explanation, memory_updates, watchlist_additions, _scratchpad", () => {
    const rich: CommandResponse = {
      _scratchpad: "private plan",
      type: "command",
      final: true,
      content: "ls",
      risk_level: "low",
      explanation: "this is user-facing",
      memory_updates: [{ fact: "uses zsh", scope: "/" }],
      memory_updates_message: "Noted: zsh",
      watchlist_additions: ["eza"],
    };
    const echoed = JSON.stringify(projectResponseForEcho(rich));
    expect(echoed).not.toContain("this is user-facing");
    expect(echoed).not.toContain("memory_updates");
    expect(echoed).not.toContain("watchlist_additions");
    expect(echoed).not.toContain("private plan");
    expect(echoed).toContain('"type":"command"');
    expect(echoed).toContain('"final":true');
  });

  test("keeps plan when set", () => {
    const withPlan: CommandResponse = { ...stepResponse, plan: "probe, then act" };
    expect(projectResponseForEcho(withPlan).plan).toBe("probe, then act");
    expect("plan" in projectResponseForEcho(stepResponse)).toBe(false);
  });
});

describe("formatCommandEcho — wrap's conversation echo predicate", () => {
  test("returns the projected echo for an ordinary response", () => {
    expect(formatCommandEcho(cmdResponse, "raw")).toBe(
      JSON.stringify(projectResponseForEcho(cmdResponse)),
    );
  });

  test("returns null for a high-risk command with a null scratchpad (domain-rejected)", () => {
    const rejected: CommandResponse = {
      _scratchpad: null,
      type: "command",
      final: true,
      content: "echo rm-rf-fake",
      risk_level: "high",
    };
    expect(formatCommandEcho(rejected, "raw")).toBeNull();
  });

  test("returns null for a high-risk command with the scratchpad omitted entirely", () => {
    const rejected: CommandResponse = {
      type: "command",
      final: true,
      content: "echo rm-rf-fake",
      risk_level: "high",
    };
    expect(formatCommandEcho(rejected, "raw")).toBeNull();
  });

  test("high-risk with a scratchpad echoes (scratchpad still stripped from the echo)", () => {
    const ok: CommandResponse = {
      _scratchpad: "deliberate destruction",
      type: "command",
      final: true,
      content: "echo rm-rf-fake",
      risk_level: "high",
    };
    const echoed = formatCommandEcho(ok, "raw");
    expect(echoed).not.toBeNull();
    expect(echoed).not.toContain("deliberate destruction");
  });

  test("medium-risk null-scratchpad commands are not domain-rejected", () => {
    const medium: CommandResponse = {
      _scratchpad: null,
      type: "command",
      final: true,
      content: "mkdir build",
      risk_level: "medium",
    };
    expect(formatCommandEcho(medium, "raw")).not.toBeNull();
  });

  test("replies are never domain-rejected", () => {
    expect(formatCommandEcho(answerResponse, "raw")).not.toBeNull();
  });

  test("a high-risk reply with null scratchpad still echoes (only commands are gated)", () => {
    const highRiskReply: CommandResponse = {
      _scratchpad: null,
      type: "reply",
      final: true,
      content: "the answer",
      risk_level: "high",
    };
    expect(formatCommandEcho(highRiskReply, "raw")).not.toBeNull();
  });
});
