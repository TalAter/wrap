import { afterEach, describe, expect, test } from "bun:test";
import { resolveApiKey } from "../src/llm/providers/ai-sdk.ts";

describe("resolveApiKey", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function deleteEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  test("returns undefined when value is undefined", () => {
    expect(resolveApiKey(undefined)).toBeUndefined();
  });

  test("resolves $ENV_VAR from environment", () => {
    setEnv("MY_TEST_KEY", "sk-secret");
    expect(resolveApiKey("$MY_TEST_KEY")).toBe("sk-secret");
  });

  test("throws when $ENV_VAR is not set", () => {
    deleteEnv("NONEXISTENT_KEY_12345");
    expect(() => resolveApiKey("$NONEXISTENT_KEY_12345")).toThrow(
      "Config error: environment variable NONEXISTENT_KEY_12345 is not set.",
    );
  });

  test("returns literal string as-is", () => {
    expect(resolveApiKey("sk-literal-key")).toBe("sk-literal-key");
  });
});
