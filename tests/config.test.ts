import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  afterEach(() => {
    delete process.env.WRAP_CONFIG;
  });

  test("returns empty config when no WRAP_CONFIG set", () => {
    const config = loadConfig({ WRAP_CONFIG: undefined });
    expect(config).toEqual({});
  });

  test("env override with undefined clears process.env value", () => {
    process.env.WRAP_CONFIG = JSON.stringify({ provider: { type: "test" } });
    const config = loadConfig({ WRAP_CONFIG: undefined });
    expect(config).toEqual({});
  });

  test("treats whitespace-only WRAP_CONFIG as unset", () => {
    const config = loadConfig({ WRAP_CONFIG: "  " });
    expect(config).toEqual({});
  });

  test("reads provider from WRAP_CONFIG env var", () => {
    const config = loadConfig({
      WRAP_CONFIG: JSON.stringify({
        provider: { type: "test" },
      }),
    });
    expect(config).toEqual({
      provider: { type: "test" },
    });
  });

  test("reads provider-specific config fields", () => {
    const config = loadConfig({
      WRAP_CONFIG: JSON.stringify({
        provider: { type: "claude-code", model: "opus" },
      }),
    });
    expect(config).toEqual({
      provider: { type: "claude-code", model: "opus" },
    });
  });

  test("throws on malformed WRAP_CONFIG", () => {
    expect(() => loadConfig({ WRAP_CONFIG: "{broken" })).toThrow(
      "Config error: WRAP_CONFIG contains invalid JSON",
    );
  });
});
