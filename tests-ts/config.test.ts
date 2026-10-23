import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const CONFIG_PATH = join(TEST_HOME, "config.jsonc");

beforeEach(() => {
  rmSync(CONFIG_PATH, { force: true });
});

afterEach(() => {
  delete process.env.WRAP_CONFIG;
});

describe("loadConfig", () => {
  describe("env var config", () => {
    test("returns empty config when no WRAP_CONFIG and no file", () => {
      expect(loadConfig({ WRAP_CONFIG: undefined })).toEqual({});
    });

    test("env override with undefined clears process.env value", () => {
      process.env.WRAP_CONFIG = JSON.stringify({
        providers: { anthropic: { model: "claude-haiku-4-5" } },
        defaultProvider: "anthropic",
      });
      expect(loadConfig({ WRAP_CONFIG: undefined })).toEqual({});
    });

    test("treats whitespace-only WRAP_CONFIG as unset", () => {
      expect(loadConfig({ WRAP_CONFIG: "  " })).toEqual({});
    });

    test("reads providers map from WRAP_CONFIG env var", () => {
      const config = loadConfig({
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
        WRAP_CONFIG: JSON.stringify({
          providers: { "claude-code": { model: "opus" } },
          defaultProvider: "claude-code",
        }),
      });
      expect(config.providers?.["claude-code"]).toEqual({ model: "opus" });
    });

    test("throws on malformed WRAP_CONFIG", () => {
      expect(() => loadConfig({ WRAP_CONFIG: "{broken" })).toThrow(
        "Config error: WRAP_CONFIG contains invalid JSON",
      );
    });
  });

  describe("file-based config", () => {
    test("reads config from config.jsonc in WRAP_HOME", () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          providers: { anthropic: { model: "claude-haiku-4-5" } },
          defaultProvider: "anthropic",
        }),
      );
      const config = loadConfig();
      expect(config.providers?.anthropic).toEqual({ model: "claude-haiku-4-5" });
      expect(config.defaultProvider).toBe("anthropic");
    });

    test("returns empty config when config file doesn't exist", () => {
      expect(loadConfig()).toEqual({});
    });

    test("handles JSONC comments", () => {
      writeFileSync(
        CONFIG_PATH,
        `{
  // LLM provider
  "providers": { "anthropic": { "model": "claude-haiku-4-5" } },
  "defaultProvider": "anthropic"
}`,
      );
      const config = loadConfig();
      expect(config.providers?.anthropic?.model).toBe("claude-haiku-4-5");
    });

    test("handles trailing commas in JSONC", () => {
      writeFileSync(
        CONFIG_PATH,
        `{
  "providers": { "anthropic": { "model": "haiku", }, },
  "defaultProvider": "anthropic",
}`,
      );
      const config = loadConfig();
      expect(config.providers?.anthropic?.model).toBe("haiku");
    });

    test("throws on malformed config file", () => {
      writeFileSync(CONFIG_PATH, "{ broken json");
      expect(() => loadConfig()).toThrow("Config error: config.jsonc contains invalid JSON");
    });
  });

  describe("config merging (shallow)", () => {
    test("WRAP_CONFIG replaces providers map from file", () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          providers: { anthropic: { model: "haiku" }, openai: { model: "gpt-4o" } },
          defaultProvider: "anthropic",
        }),
      );
      const config = loadConfig({
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
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          providers: { anthropic: { apiKey: "$KEY", model: "haiku" } },
        }),
      );
      const config = loadConfig({
        // env providers map has no model — file's model should NOT carry over
        WRAP_CONFIG: JSON.stringify({
          providers: { anthropic: { apiKey: "$OTHER" } },
        }),
      });
      expect(config.providers).toEqual({ anthropic: { apiKey: "$OTHER" } });
    });

    test("file config used when no WRAP_CONFIG", () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          providers: { "claude-code": { model: "opus" } },
          defaultProvider: "claude-code",
        }),
      );
      const config = loadConfig({ WRAP_CONFIG: undefined });
      expect(config.providers?.["claude-code"]?.model).toBe("opus");
      expect(config.defaultProvider).toBe("claude-code");
    });
  });

  describe("maxRounds", () => {
    test("reads maxRounds from config file", () => {
      writeFileSync(CONFIG_PATH, JSON.stringify({ maxRounds: 3 }));
      expect(loadConfig().maxRounds).toBe(3);
    });

    test("reads maxRounds from WRAP_CONFIG", () => {
      const config = loadConfig({ WRAP_CONFIG: JSON.stringify({ maxRounds: 7 }) });
      expect(config.maxRounds).toBe(7);
    });

    test("maxRounds is undefined when not set", () => {
      const config = loadConfig({ WRAP_CONFIG: JSON.stringify({}) });
      expect(config.maxRounds).toBeUndefined();
    });
  });

  describe("maxCapturedOutputChars", () => {
    test("reads from config file", () => {
      writeFileSync(CONFIG_PATH, JSON.stringify({ maxCapturedOutputChars: 50000 }));
      expect(loadConfig().maxCapturedOutputChars).toBe(50000);
    });

    test("reads from WRAP_CONFIG", () => {
      const config = loadConfig({
        WRAP_CONFIG: JSON.stringify({ maxCapturedOutputChars: 100000 }),
      });
      expect(config.maxCapturedOutputChars).toBe(100000);
    });

    test("undefined when not set", () => {
      const config = loadConfig({ WRAP_CONFIG: JSON.stringify({}) });
      expect(config.maxCapturedOutputChars).toBeUndefined();
    });
  });

  describe("JSON Schema", () => {
    test("config.jsonc with $schema property parses correctly", () => {
      writeFileSync(
        CONFIG_PATH,
        `{
  "$schema": "./config.schema.json",
  "providers": { "anthropic": { "model": "haiku" } },
  "defaultProvider": "anthropic"
}`,
      );
      expect(loadConfig().providers?.anthropic?.model).toBe("haiku");
    });
  });

  describe("maxAttachedInputChars", () => {
    test("reads from config file", () => {
      writeFileSync(CONFIG_PATH, JSON.stringify({ maxAttachedInputChars: 50000 }));
      expect(loadConfig().maxAttachedInputChars).toBe(50000);
    });

    test("reads from WRAP_CONFIG", () => {
      const config = loadConfig({ WRAP_CONFIG: JSON.stringify({ maxAttachedInputChars: 100000 }) });
      expect(config.maxAttachedInputChars).toBe(100000);
    });

    test("undefined when not set", () => {
      const config = loadConfig({ WRAP_CONFIG: JSON.stringify({}) });
      expect(config.maxAttachedInputChars).toBeUndefined();
    });
  });
});
