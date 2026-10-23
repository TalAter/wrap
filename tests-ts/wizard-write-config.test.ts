import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildConfig, writeWizardConfig } from "../src/wizard/write-config.ts";
import { TEST_HOME } from "./wrap-home-preload.ts";

const CONFIG_PATH = join(TEST_HOME, "config.jsonc");

describe("buildConfig", () => {
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

  test("includes nerdFonts: true when passed", () => {
    const config = buildConfig(
      { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      "anthropic",
      true,
    );
    expect(config.nerdFonts).toBe(true);
  });
});

describe("writeWizardConfig", () => {
  beforeEach(() => {
    rmSync(CONFIG_PATH, { force: true });
  });

  test("writes config.jsonc with $schema + providers + defaultProvider", () => {
    writeWizardConfig({
      entries: { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      defaultProvider: "anthropic",
    });
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.$schema).toBe("./config.schema.json");
    expect(parsed.providers).toEqual({
      anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" },
    });
    expect(parsed.defaultProvider).toBe("anthropic");
  });

  test("serializes with 2-space indent (human-readable)", () => {
    writeWizardConfig({
      entries: { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      defaultProvider: "anthropic",
    });
    const raw = readFileSync(CONFIG_PATH, "utf8");
    expect(raw).toContain('  "providers"');
    expect(raw).toContain('    "anthropic"');
  });

  test("writes multi-provider config in given order", () => {
    writeWizardConfig({
      entries: {
        anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" },
        openai: { apiKey: "sk-o", model: "gpt-5" },
      },
      defaultProvider: "openai",
    });
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(Object.keys(parsed.providers)).toEqual(["anthropic", "openai"]);
    expect(parsed.defaultProvider).toBe("openai");
  });

  test("writes nerdFonts: true to disk when set", () => {
    writeWizardConfig({
      entries: { anthropic: { apiKey: "sk-ant", model: "claude-sonnet-4-6" } },
      defaultProvider: "anthropic",
      nerdFonts: true,
    });
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(parsed.nerdFonts).toBe(true);
  });

  test("validation error prevents the file from being written", () => {
    expect(() =>
      writeWizardConfig({
        entries: { ollama: { model: "llama3.2" } },
        defaultProvider: "ollama",
      }),
    ).toThrow(/ollama.*requires baseURL/);
    expect(() => readFileSync(CONFIG_PATH, "utf8")).toThrow();
  });
});
