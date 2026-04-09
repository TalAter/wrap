import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import configSchema from "../src/config/config.schema.json";
import {
  DEFAULT_MAX_CAPTURED_OUTPUT_CHARS,
  DEFAULT_MAX_PIPED_INPUT_CHARS,
  DEFAULT_MAX_ROUNDS,
  loadConfig,
} from "../src/config/config.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wrap-test-"));
}

describe("loadConfig", () => {
  afterEach(() => {
    delete process.env.WRAP_CONFIG;
  });

  describe("env var config", () => {
    test("returns empty config when no WRAP_CONFIG and no file", () => {
      const config = loadConfig({ WRAP_HOME: tempDir(), WRAP_CONFIG: undefined });
      expect(config).toEqual({});
    });

    test("env override with undefined clears process.env value", () => {
      process.env.WRAP_CONFIG = JSON.stringify({
        providers: { anthropic: { model: "claude-haiku-4-5" } },
        defaultProvider: "anthropic",
      });
      const config = loadConfig({ WRAP_HOME: tempDir(), WRAP_CONFIG: undefined });
      expect(config).toEqual({});
    });

    test("treats whitespace-only WRAP_CONFIG as unset", () => {
      const config = loadConfig({ WRAP_HOME: tempDir(), WRAP_CONFIG: "  " });
      expect(config).toEqual({});
    });

    test("reads providers map from WRAP_CONFIG env var", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({
          providers: { anthropic: { model: "claude-haiku-4-5" } },
          defaultProvider: "anthropic",
        }),
      });
      expect(config.providers).toEqual({ anthropic: { model: "claude-haiku-4-5" } });
      expect(config.defaultProvider).toBe("anthropic");
    });

    test("reads provider entry fields", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({
          providers: { "claude-code": { model: "opus" } },
          defaultProvider: "claude-code",
        }),
      });
      expect(config.providers?.["claude-code"]).toEqual({ model: "opus" });
    });

    test("throws on malformed WRAP_CONFIG", () => {
      expect(() => loadConfig({ WRAP_HOME: tempDir(), WRAP_CONFIG: "{broken" })).toThrow(
        "Config error: WRAP_CONFIG contains invalid JSON",
      );
    });
  });

  describe("file-based config", () => {
    test("reads config from config.jsonc in WRAP_HOME", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          providers: { anthropic: { model: "claude-haiku-4-5" } },
          defaultProvider: "anthropic",
        }),
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.providers?.anthropic).toEqual({ model: "claude-haiku-4-5" });
      expect(config.defaultProvider).toBe("anthropic");
    });

    test("returns empty config when config file doesn't exist", () => {
      const config = loadConfig({ WRAP_HOME: tempDir() });
      expect(config).toEqual({});
    });

    test("handles JSONC comments", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        `{
  // LLM provider
  "providers": { "anthropic": { "model": "claude-haiku-4-5" } },
  "defaultProvider": "anthropic"
}`,
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.providers?.anthropic?.model).toBe("claude-haiku-4-5");
    });

    test("handles trailing commas in JSONC", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        `{
  "providers": { "anthropic": { "model": "haiku", }, },
  "defaultProvider": "anthropic",
}`,
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.providers?.anthropic?.model).toBe("haiku");
    });

    test("throws on malformed config file", () => {
      const dir = tempDir();
      writeFileSync(join(dir, "config.jsonc"), "{ broken json");
      expect(() => loadConfig({ WRAP_HOME: dir })).toThrow(
        "Config error: config.jsonc contains invalid JSON",
      );
    });
  });

  describe("config merging (shallow)", () => {
    test("WRAP_CONFIG replaces providers map from file", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          providers: { anthropic: { model: "haiku" }, openai: { model: "gpt-4o" } },
          defaultProvider: "anthropic",
        }),
      );
      const config = loadConfig({
        WRAP_HOME: dir,
        WRAP_CONFIG: JSON.stringify({
          providers: { "claude-code": { model: "sonnet" } },
        }),
      });
      // env's providers replaces file's providers entirely — anthropic and openai are gone
      expect(config.providers).toEqual({ "claude-code": { model: "sonnet" } });
      // defaultProvider from file is preserved (not in WRAP_CONFIG)
      expect(config.defaultProvider).toBe("anthropic");
    });

    test("nested providers are not deep merged", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          providers: { anthropic: { apiKey: "$KEY", model: "haiku" } },
        }),
      );
      const config = loadConfig({
        WRAP_HOME: dir,
        // env providers map has no model — file's model should NOT carry over
        WRAP_CONFIG: JSON.stringify({
          providers: { anthropic: { apiKey: "$OTHER" } },
        }),
      });
      expect(config.providers).toEqual({ anthropic: { apiKey: "$OTHER" } });
    });

    test("file config used when no WRAP_CONFIG", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          providers: { "claude-code": { model: "opus" } },
          defaultProvider: "claude-code",
        }),
      );
      const config = loadConfig({ WRAP_HOME: dir, WRAP_CONFIG: undefined });
      expect(config.providers?.["claude-code"]?.model).toBe("opus");
      expect(config.defaultProvider).toBe("claude-code");
    });
  });

  describe("WRAP_HOME", () => {
    test("defaults to ~/.wrap/ when WRAP_HOME not set", () => {
      // With no WRAP_HOME override, loadConfig should not crash
      // (it reads from ~/.wrap/ which may or may not exist)
      const config = loadConfig({ WRAP_CONFIG: undefined });
      // If ~/.wrap/config.jsonc doesn't exist, we get empty config
      // If it does exist, we get whatever's in it
      // Either way, it should not throw
      expect(config).toBeDefined();
    });

    test("returns empty config when WRAP_HOME directory does not exist", () => {
      const nonexistent = join(tempDir(), "does-not-exist");
      const config = loadConfig({ WRAP_HOME: nonexistent });
      expect(config).toEqual({});
    });
  });

  describe("maxRounds", () => {
    test("reads maxRounds from config file", () => {
      const dir = tempDir();
      writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ maxRounds: 3 }));
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.maxRounds).toBe(3);
    });

    test("reads maxRounds from WRAP_CONFIG", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({ maxRounds: 7 }),
      });
      expect(config.maxRounds).toBe(7);
    });

    test("maxRounds is undefined when not set", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({}),
      });
      expect(config.maxRounds).toBeUndefined();
    });
  });

  describe("maxCapturedOutputChars", () => {
    test("reads from config file", () => {
      const dir = tempDir();
      writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ maxCapturedOutputChars: 50000 }));
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.maxCapturedOutputChars).toBe(50000);
    });

    test("reads from WRAP_CONFIG", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({ maxCapturedOutputChars: 100000 }),
      });
      expect(config.maxCapturedOutputChars).toBe(100000);
    });

    test("undefined when not set", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({}),
      });
      expect(config.maxCapturedOutputChars).toBeUndefined();
    });
  });

  describe("JSON Schema", () => {
    test("config.jsonc with $schema property parses correctly", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        `{
  "$schema": "./config.schema.json",
  "providers": { "anthropic": { "model": "haiku" } },
  "defaultProvider": "anthropic"
}`,
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.providers?.anthropic?.model).toBe("haiku");
    });

    test("exported configSchema documents providers + defaultProvider", () => {
      expect(configSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(configSchema.type).toBe("object");
      expect(configSchema.properties.providers.type).toBe("object");
      expect(configSchema.properties.providers.additionalProperties.type).toBe("object");
      expect(configSchema.properties.defaultProvider.type).toBe("string");
    });

    test("configSchema includes maxRounds with default 5", () => {
      const mr = configSchema.properties.maxRounds;
      expect(mr.type).toBe("integer");
      expect(mr.default).toBe(DEFAULT_MAX_ROUNDS);
      expect(mr.minimum).toBe(1);
    });

    test("configSchema includes maxCapturedOutputChars with default 200000", () => {
      const mp = configSchema.properties.maxCapturedOutputChars;
      expect(mp.type).toBe("integer");
      expect(mp.default).toBe(DEFAULT_MAX_CAPTURED_OUTPUT_CHARS);
      expect(mp.minimum).toBe(1000);
    });

    test("configSchema includes maxPipedInputChars with default 200000", () => {
      const mp = configSchema.properties.maxPipedInputChars;
      expect(mp.type).toBe("integer");
      expect(mp.default).toBe(DEFAULT_MAX_PIPED_INPUT_CHARS);
      expect(mp.minimum).toBe(1000);
    });
  });

  describe("maxPipedInputChars", () => {
    test("reads from config file", () => {
      const dir = tempDir();
      writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ maxPipedInputChars: 50000 }));
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.maxPipedInputChars).toBe(50000);
    });

    test("reads from WRAP_CONFIG", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({ maxPipedInputChars: 100000 }),
      });
      expect(config.maxPipedInputChars).toBe(100000);
    });

    test("undefined when not set", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({}),
      });
      expect(config.maxPipedInputChars).toBeUndefined();
    });
  });
});
