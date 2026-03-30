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
  toolsOutput: "/usr/bin/git",
  cwd: "/home/user",
  piped: false,
  query: "list files",
};

const TEST_PROVIDER_ENV = {
  WRAP_CONFIG: JSON.stringify({ provider: { type: "test" } }),
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

  test("context includes tools output", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).toContain("/usr/bin/git");
  });

  test("context includes cwdFiles when provided", async () => {
    const result = await bridgeResult({
      ...baseInput,
      mode: "assemble",
      cwdFiles: "package.json\nsrc/\nREADME.md",
    });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).toContain("## Files in CWD");
    expect(last.content).toContain("package.json");
    expect(last.content).toContain("src/");
  });

  test("context omits cwdFiles section when not provided", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).not.toContain("Files in CWD");
  });

  test("final message contains query under user request header", async () => {
    const result = await bridgeResult({ ...baseInput, mode: "assemble" });
    const last = result.promptInput.messages.at(-1);
    expect(last.content).toContain("## User's request\nlist files");
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
  });

  test("invalid_schema: JSON doesn't match CommandResponseSchema", async () => {
    const result = await bridgeResult(
      { ...baseInput, mode: "execute" },
      { ...TEST_PROVIDER_ENV, WRAP_TEST_RESPONSE: '{"type":"unknown","content":"x"}' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_schema");
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
