import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureConfig } from "../src/config/ensure.ts";
import { tmpHome } from "./helpers.ts";

describe("ensureConfig", () => {
  test("returns existing config when config.jsonc exists", async () => {
    const home = tmpHome();
    writeFileSync(
      join(home, "config.jsonc"),
      JSON.stringify({
        providers: { anthropic: { apiKey: "sk-test", model: "claude-haiku-4-5" } },
        defaultProvider: "anthropic",
      }),
    );
    const { config, justCreated } = await ensureConfig({ WRAP_HOME: home });
    expect(config.providers?.anthropic?.model).toBe("claude-haiku-4-5");
    expect(config.defaultProvider).toBe("anthropic");
    expect(justCreated).toBe(false);
  });

  test("returns existing config even if it has no providers (user's problem)", async () => {
    const home = tmpHome();
    writeFileSync(join(home, "config.jsonc"), "{}");
    const { config, justCreated } = await ensureConfig({ WRAP_HOME: home });
    expect(config).toEqual({});
    expect(justCreated).toBe(false);
  });

  test("launches wizard when config.jsonc is missing and writes config + schema on done", async () => {
    const home = tmpHome();
    const fakeResult = {
      entries: { anthropic: { apiKey: "sk-new", model: "claude-sonnet-4-6" } },
      defaultProvider: "anthropic",
    };

    const { config, justCreated } = await ensureConfig({
      WRAP_HOME: home,
      _testWizardResult: fakeResult,
    });

    expect(config.providers?.anthropic?.apiKey).toBe("sk-new");
    expect(config.providers?.anthropic?.model).toBe("claude-sonnet-4-6");
    expect(config.defaultProvider).toBe("anthropic");
    expect(justCreated).toBe(true);

    // Verify config.jsonc was written
    const raw = readFileSync(join(home, "config.jsonc"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.$schema).toBe("./config.schema.json");

    // Verify config.schema.json was written
    const schema = JSON.parse(readFileSync(join(home, "config.schema.json"), "utf8"));
    expect(schema.$schema).toContain("json-schema");
  });

  test("wizard cancel exits with code 0", async () => {
    const home = tmpHome();
    let exitCode: number | undefined;
    const originalExit = process.exit;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;
    try {
      await ensureConfig({
        WRAP_HOME: home,
        _testWizardResult: null,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("unreachable");
    }
    process.exit = originalExit;
    expect(exitCode).toBe(0);
  });

  test("WRAP_CONFIG env skips wizard even without config file", async () => {
    const home = tmpHome();
    // No config.jsonc file, but WRAP_CONFIG provides config via env
    const originalEnv = process.env.WRAP_CONFIG;
    process.env.WRAP_CONFIG = JSON.stringify({
      providers: { anthropic: { apiKey: "env-key", model: "claude-haiku-4-5" } },
      defaultProvider: "anthropic",
    });
    try {
      const { config } = await ensureConfig({ WRAP_HOME: home });
      expect(config.providers?.anthropic?.apiKey).toBe("env-key");
      expect(config.defaultProvider).toBe("anthropic");
    } finally {
      if (originalEnv === undefined) delete process.env.WRAP_CONFIG;
      else process.env.WRAP_CONFIG = originalEnv;
    }
  });
});
