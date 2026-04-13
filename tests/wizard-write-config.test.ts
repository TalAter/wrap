import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEntry } from "../src/config/config.ts";
import { buildConfig, writeWizardConfig } from "../src/wizard/write-config.ts";
import { tmpHome } from "./helpers.ts";

describe("buildConfig", () => {
  test("returns Config with providers and defaultProvider", () => {
    const entries: Record<string, ProviderEntry> = {
      anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" },
    };
    const config = buildConfig(entries, "anthropic");
    expect(config.providers).toEqual(entries);
    expect(config.defaultProvider).toBe("anthropic");
  });

  test("rejects entries that fail validateProviderEntry (ollama without baseURL)", () => {
    expect(() => buildConfig({ ollama: { model: "llama3.2" } }, "ollama")).toThrow(
      /ollama.*requires baseURL/,
    );
  });

  test("accepts claude-code entry with no model", () => {
    const config = buildConfig({ "claude-code": {} }, "claude-code");
    expect(config.providers?.["claude-code"]).toEqual({});
  });

  test("rejects unknown provider missing required fields", () => {
    expect(() => buildConfig({ custom: { model: "foo" } }, "custom")).toThrow(
      /requires baseURL, apiKey, and model/,
    );
  });

  test("includes nerdFonts: false by default", () => {
    const config = buildConfig(
      { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      "anthropic",
    );
    expect(config.nerdFonts).toBe(false);
  });
});

describe("writeWizardConfig", () => {
  test("writes config.jsonc with $schema + providers + defaultProvider", () => {
    const home = tmpHome();
    writeWizardConfig(
      { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      "anthropic",
      home,
    );
    const raw = readFileSync(join(home, "config.jsonc"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.$schema).toBe("./config.schema.json");
    expect(parsed.providers).toEqual({
      anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" },
    });
    expect(parsed.defaultProvider).toBe("anthropic");
  });

  test("serializes with 2-space indent (human-readable)", () => {
    const home = tmpHome();
    writeWizardConfig(
      { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      "anthropic",
      home,
    );
    const raw = readFileSync(join(home, "config.jsonc"), "utf8");
    expect(raw).toContain('  "providers"');
    expect(raw).toContain('    "anthropic"');
  });

  test("writes multi-provider config in given order", () => {
    const home = tmpHome();
    writeWizardConfig(
      {
        anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" },
        openai: { apiKey: "sk-o", model: "gpt-5" },
      },
      "openai",
      home,
    );
    const parsed = JSON.parse(readFileSync(join(home, "config.jsonc"), "utf8"));
    expect(Object.keys(parsed.providers)).toEqual(["anthropic", "openai"]);
    expect(parsed.defaultProvider).toBe("openai");
  });

  test("validation error prevents the file from being written", () => {
    const home = tmpHome();
    expect(() => writeWizardConfig({ ollama: { model: "llama3.2" } }, "ollama", home)).toThrow(
      /ollama.*requires baseURL/,
    );
    expect(() => readFileSync(join(home, "config.jsonc"), "utf8")).toThrow();
  });
});
