import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BRIDGE = join(import.meta.dir, "../eval/bridge.ts");

async function runBridge(input: object, env?: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", BRIDGE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function bridgeResult(input: object, env?: Record<string, string>) {
  const { exitCode, stdout, stderr } = await runBridge(input, env);
  if (exitCode !== 0) throw new Error(`Bridge crashed (exit ${exitCode}): ${stderr}`);
  return JSON.parse(stdout);
}

const baseInput = {
  instruction: "You are a CLI tool.",
  fewShotExamples: [] as { input: string; output: string }[],
  schemaText: "z.object({ type: z.string() })",
  memory: { "/": [{ fact: "macOS arm64" }] },
  cwd: "/home/user",
  piped: false,
  query: "list files",
};

const TEST_PROVIDER_ENV = {
  WRAP_CONFIG: JSON.stringify({}),
};

describe("bridge — assemble mode", () => {
  test("returns ok: true with promptInput", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    expect(result.ok).toBe(true);
    expect(result.promptInput).toBeDefined();
    expect(result.promptInput.system).toContain("You are a CLI tool.");
    expect(result.promptInput.messages).toBeArray();
  });

  test("context includes memory facts", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).toContain("macOS arm64");
  });

  test("context no longer carries tool sections (moved to discovery skill)", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).not.toContain("## Detected tools");
    expect(last.content).not.toContain("## Unavailable tools");
  });

  test("context no longer carries Files in CWD section (moved to discovery skill)", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).not.toContain("Files in CWD");
  });

  test("legacy tools/cwdFiles fields cause loud failure (non-zero exit)", async () => {
    // Probe state moved to transcript turns via the discovery skill. Stale
    // callers that still send `tools`/`cwdFiles` must fail loudly so eval
    // signal can't silently degrade.
    const { exitCode, stderr } = await runBridge({
      ...baseInput,
      mode: "assemble",
      tools: { available: ["/usr/bin/git"], unavailable: ["docker"] },
      cwdFiles: "package.json\nsrc/\n",
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/tools|cwdFiles|unrecognized/i);
  });

  test("final message contains query under user request header", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).toContain("## User's request\nlist files");
  });

  test("lastRound appends instruction as separate user message", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble", lastRound: true });
    const msgs = result.promptInput.messages;
    const lastMsg = msgs.at(-1);
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("terminal response");
    // Instruction is separate from the user request
    const requestMsg = msgs.at(-2);
    expect(requestMsg.content).toContain("list files");
    expect(requestMsg.content).not.toContain("terminal response");
  });

  test("extraMessages are prior turns; current query is the last user message", async () => {
    // extraMessages = everything that came BEFORE the current user query
    // (prior round turns + simulated skill emissions). `input.query` is
    // always the latest/current user turn and sits at the end. Mirrors
    // runtime where skill turns precede the user prompt.
    const result = await bridgeResult({
      ...baseInput,
      mode: "assemble",
      extraMessages: [
        { role: "assistant", content: '{"type":"probe","content":"which sips"}' },
        { role: "user", content: "## Probe output\n/usr/bin/sips" },
      ],
    });
    const msgs = result.promptInput.messages;
    // Last message: the current user query.
    const lastMsg = msgs.at(-1);
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("list files");
    // Second to last: the probe output (last entry in extraMessages).
    const probeOutMsg = msgs.at(-2);
    expect(probeOutMsg.role).toBe("user");
    expect(probeOutMsg.content).toContain("Probe output");
    // Third to last: the assistant probe turn (first entry in extraMessages).
    const assistantMsg = msgs.at(-3);
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toContain("probe");
  });

  test("captured-output user messages in extraMessages don't consume request framing", async () => {
    // A skill/probe simulation puts an assistant probe + a captured-output
    // user turn into extraMessages. The captured-output message must be
    // mapped to a step turn so request framing attaches to the actual
    // current query, not to the probe output. Mirrors runtime where step
    // turns are `kind: "step"` and `firstUserSeen` ignores them.
    const result = await bridgeResult({
      ...baseInput,
      mode: "assemble",
      extraMessages: [
        {
          role: "assistant",
          content: '{"type":"command","final":false,"content":"which ffmpeg","risk_level":"low"}',
        },
        { role: "user", content: "## Captured output\n/opt/homebrew/bin/ffmpeg" },
      ],
    });
    const msgs = result.promptInput.messages;
    const lastMsg = msgs.at(-1);
    expect(lastMsg.role).toBe("user");
    // Framing landed on the current query, not on the probe output.
    expect(lastMsg.content).toContain("## User's request\nlist files");
    // Probe output is still present as a step-projected user message.
    const stepMsg = msgs.at(-2);
    expect(stepMsg.role).toBe("user");
    expect(stepMsg.content).toContain("## Captured output");
    expect(stepMsg.content).toContain("/opt/homebrew/bin/ffmpeg");
    // No double-framing on the step message.
    expect(stepMsg.content).not.toContain("## User's request");
  });

  test("extraMessages + lastRound: instruction is last; current query precedes it", async () => {
    const result = await bridgeResult({
      ...baseInput,
      mode: "assemble",
      extraMessages: [
        { role: "assistant", content: '{"type":"probe"}' },
        { role: "user", content: "## Probe output\nresult" },
      ],
      lastRound: true,
    });
    const msgs = result.promptInput.messages;
    // Last message: last-round instruction.
    expect(msgs.at(-1).content).toContain("terminal response");
    // Second to last: the current user query.
    expect(msgs.at(-2).content).toContain("list files");
    // Third to last: the probe output (last entry in extraMessages).
    expect(msgs.at(-3).content).toContain("Probe output");
  });

  test("few-shot examples become user/assistant pairs with separator", async () => {
    const input = {
      ...baseInput,
      mode: "assemble",
      fewShotExamples: [{ input: "do stuff", output: '{"result":"done"}' }],
    };
    const result = await bridgeResult(input);
    const msgs = result.promptInput.messages;
    expect(msgs[0]).toEqual({ role: "user", content: "do stuff" });
    expect(msgs[1]).toEqual({ role: "assistant", content: '{"result":"done"}' });
    expect(msgs[2]).toEqual({ role: "user", content: "Now handle the following request." });
  });
});

describe("bridge — execute mode", () => {
  const validResponse = JSON.stringify({
    type: "command",
    content: "ls -la",
    risk_level: "low",
    explanation: "List files with details",
  });

  test("success: returns validated response", async () => {
    const result = await bridgeResult(
      { ...baseInput, mode: "execute" },
      { ...TEST_PROVIDER_ENV, WRAP_TEST_RESPONSE: validResponse },
    );
    expect(result.ok).toBe(true);
    expect(result.response.type).toBe("command");
    expect(result.response.content).toBe("ls -la");
  });

  test("invalid_json: model output is not JSON", async () => {
    const result = await bridgeResult(
      { ...baseInput, mode: "execute" },
      { ...TEST_PROVIDER_ENV, WRAP_TEST_RESPONSE: "Sure! Here is the command..." },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_json");
    // The raw model text is the optimizer's signal — it must ride along.
    expect(result.rawText).toBe("Sure! Here is the command...");
  });

  test("invalid_schema: JSON doesn't match CommandResponseSchema", async () => {
    const result = await bridgeResult(
      { ...baseInput, mode: "execute" },
      { ...TEST_PROVIDER_ENV, WRAP_TEST_RESPONSE: '{"type":"unknown","content":"x"}' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_schema");
    expect(result.rawText).toBe('{"type":"unknown","content":"x"}');
  });

  test("execute makes exactly one attempt — no parse retry", async () => {
    // Malformed output is the optimization signal: with a retry, the second
    // canned entry would parse and the failure would be hidden as a success.
    const result = await bridgeResult(
      { ...baseInput, mode: "execute" },
      { ...TEST_PROVIDER_ENV, WRAP_TEST_RESPONSES: JSON.stringify(["not json", validResponse]) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_json");
  });

  test("provider_error: provider throws", async () => {
    const result = await bridgeResult(
      { ...baseInput, mode: "execute" },
      { ...TEST_PROVIDER_ENV, WRAP_TEST_RESPONSE: "ERROR:429 rate limit exceeded" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("provider_error");
    expect(result.message).toContain("rate limit");
  });
});

describe("bridge — fatal errors", () => {
  test("non-zero exit on invalid stdin JSON", async () => {
    const proc = Bun.spawn(["bun", "run", BRIDGE], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("not json{{{");
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});
