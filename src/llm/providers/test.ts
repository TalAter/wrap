import type { Provider } from "../types.ts";

export function testProvider(): Provider {
  const runPrompt: Provider["runPrompt"] = async (_systemPrompt, userPrompt, _jsonSchema) => {
    return process.env.WRAP_TEST_RESPONSE ?? userPrompt;
  };

  return {
    runPrompt,
    runCommandPrompt: async (prompt) => {
      return (
        process.env.WRAP_TEST_RESPONSE ??
        JSON.stringify({ type: "command", command: prompt, risk_level: "low" })
      );
    },
  };
}
