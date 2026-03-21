import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import configSchema from "../src/config/config.schema.json";
import { loadConfig } from "../src/config/config.ts";

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
      process.env.WRAP_CONFIG = JSON.stringify({ provider: { type: "test" } });
      const config = loadConfig({ WRAP_HOME: tempDir(), WRAP_CONFIG: undefined });
      expect(config).toEqual({});
    });

    test("treats whitespace-only WRAP_CONFIG as unset", () => {
      const config = loadConfig({ WRAP_HOME: tempDir(), WRAP_CONFIG: "  " });
      expect(config).toEqual({});
    });

    test("reads provider from WRAP_CONFIG env var", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({ provider: { type: "test" } }),
      });
      expect(config).toEqual({ provider: { type: "test" } });
    });

    test("reads provider-specific config fields", () => {
      const config = loadConfig({
        WRAP_HOME: tempDir(),
        WRAP_CONFIG: JSON.stringify({
          provider: { type: "claude-code", model: "opus" },
        }),
      });
      expect(config).toEqual({
        provider: { type: "claude-code", model: "opus" },
      });
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
      writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ provider: { type: "test" } }));
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.provider).toEqual({ type: "test" });
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
  "provider": { "type": "test" }
}`,
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.provider).toEqual({ type: "test" });
    });

    test("handles trailing commas in JSONC", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        `{
  "provider": { "type": "test", },
}`,
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.provider).toEqual({ type: "test" });
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
    test("WRAP_CONFIG replaces nested objects from file", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          provider: { type: "claude-code", model: "haiku" },
        }),
      );
      const config = loadConfig({
        WRAP_HOME: dir,
        WRAP_CONFIG: JSON.stringify({ provider: { type: "test" } }),
      });
      // env's provider replaces file's provider entirely
      expect(config.provider).toEqual({ type: "test" });
    });

    test("nested objects are not deep merged", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          provider: { type: "claude-code", model: "haiku" },
        }),
      );
      const config = loadConfig({
        WRAP_HOME: dir,
        // env provider has no model — file's model should NOT carry over
        WRAP_CONFIG: JSON.stringify({ provider: { type: "claude-code" } }),
      });
      expect(config.provider).toEqual({ type: "claude-code" });
    });

    test("file config used when no WRAP_CONFIG", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        JSON.stringify({
          provider: { type: "claude-code", model: "opus" },
        }),
      );
      const config = loadConfig({ WRAP_HOME: dir, WRAP_CONFIG: undefined });
      expect(config.provider).toEqual({ type: "claude-code", model: "opus" });
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
  });

  describe("JSON Schema", () => {
    test("config.jsonc with $schema property parses correctly", () => {
      const dir = tempDir();
      writeFileSync(
        join(dir, "config.jsonc"),
        `{
  "$schema": "./config.schema.json",
  "provider": { "type": "test" }
}`,
      );
      const config = loadConfig({ WRAP_HOME: dir });
      expect(config.provider).toEqual({ type: "test" });
    });

    test("exported configSchema is valid JSON Schema with oneOf provider", () => {
      expect(configSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(configSchema.type).toBe("object");
      expect(configSchema.properties.provider.oneOf.length).toBeGreaterThan(0);
    });
  });
});
