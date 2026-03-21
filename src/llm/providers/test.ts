import type { LLM } from "../types.ts";

export function testProvider(): LLM {
  return async (prompt) => {
    const fixed = process.env.WRAP_TEST_RESPONSE;
    if (fixed) return fixed;
    return JSON.stringify({ type: "command", command: prompt, risk_level: "low" });
  };
}
