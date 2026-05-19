import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureConfig } from "../src/config/ensure.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

describe("ensureConfig", () => {
  test("returns existing config when config.jsonc exists", async () => {
    writeFileSync(
      join(TEST_HOME, "config.jsonc"),
      JSON.stringify({
        providers: { anthropic: { apiKey: "sk-test", model: "claude-haiku-4-5" } },
        defaultProvider: "anthropic",
      }),
    );
    const { config, justCreated } = await ensureConfig();
    expect(config.providers?.anthropic?.model).toBe("claude-haiku-4-5");
    expect(config.defaultProvider).toBe("anthropic");
    expect(justCreated).toBe(false);
  });

  test("returns existing config even if it has no providers (user's problem)", async () => {
    writeFileSync(join(TEST_HOME, "config.jsonc"), "{}");
    const { config, justCreated } = await ensureConfig();
    expect(config).toEqual({});
    expect(justCreated).toBe(false);
  });

  test("launches wizard when config.jsonc is missing and writes config + schema on done", async () => {
    const fakeResult = {
      entries: { anthropic: { apiKey: "sk-new", model: "claude-sonnet-4-6" } },
      defaultProvider: "anthropic",
    };

    let exitCalled = false;
    const originalExit = process.exit;
    process.exit = ((_code?: number) => {
      exitCalled = true;
    }) as never;
    try {
      const { config, justCreated } = await ensureConfig({ _testWizardResult: fakeResult });

      expect(exitCalled).toBe(false);
      expect(config.providers?.anthropic?.apiKey).toBe("sk-new");
      expect(config.providers?.anthropic?.model).toBe("claude-sonnet-4-6");
      expect(config.defaultProvider).toBe("anthropic");
      expect(justCreated).toBe(true);

      const raw = readFileSync(join(TEST_HOME, "config.jsonc"), "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.$schema).toBe("./config.schema.json");

      const schema = JSON.parse(readFileSync(join(TEST_HOME, "config.schema.json"), "utf8"));
      expect(schema.$schema).toContain("json-schema");
    } finally {
      process.exit = originalExit;
    }
  });

  test("wizard cancel exits with code 0", async () => {
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    try {
      await ensureConfig({ _testWizardResult: null });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("unreachable");
    }
    process.exit = originalExit;
    expect(exitCode).toBe(0);
  });

  test("WRAP_CONFIG env skips wizard even without config file", async () => {
    const originalEnv = process.env.WRAP_CONFIG;
    process.env.WRAP_CONFIG = JSON.stringify({
      providers: { anthropic: { apiKey: "env-key", model: "claude-haiku-4-5" } },
      defaultProvider: "anthropic",
    });
    try {
      const { config } = await ensureConfig();
      expect(config.providers?.anthropic?.apiKey).toBe("env-key");
      expect(config.defaultProvider).toBe("anthropic");
    } finally {
      if (originalEnv === undefined) delete process.env.WRAP_CONFIG;
      else process.env.WRAP_CONFIG = originalEnv;
    }
  });
});
