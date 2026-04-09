import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandResponseJsonSchema } from "../src/command-response.schema.ts";
import promptOptimized from "../src/prompt.optimized.json";

// Provider-side reordering (Anthropic tool-use runtime, OpenAI strict mode
// runtime) is vendor behavior and cannot be detected here. If scratchpad
// quality on a new provider regresses, check whether the provider reorders
// tool-input properties. This test only covers Wrap → ai-sdk → SDK.
describe("CommandResponseSchema key order", () => {
  test("_scratchpad is the first key of CommandResponseJsonSchema", () => {
    const props = (CommandResponseJsonSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)[0]).toBe("_scratchpad");
  });
});

describe("schemaText mirror", () => {
  test("prompt.optimized.json schemaText matches schema source between markers", () => {
    const schemaPath = join(import.meta.dir, "..", "src", "command-response.schema.ts");
    const source = readFileSync(schemaPath, "utf8");
    const match = source.match(/\/\/ SCHEMA_START\n([\s\S]*?)\n\/\/ SCHEMA_END/);
    expect(match).not.toBeNull();
    const sourceSchema = (match?.[1] ?? "").trim();
    expect(promptOptimized.schemaText.trim()).toBe(sourceSchema);
  });
});
