import type { Provider } from "../types.ts";

export function testProvider(): Provider {
  let callIndex = 0;
  return {
    runPrompt: async (input, schema?) => {
      let raw: string;
      const responsesJson = process.env.WRAP_TEST_RESPONSES;
      if (responsesJson) {
        const responses = JSON.parse(responsesJson);
        if (callIndex >= responses.length) {
          throw new Error(
            `Test provider: no response for call ${callIndex} (only ${responses.length} responses provided)`,
          );
        }
        const entry = responses[callIndex++];
        raw = typeof entry === "string" ? entry : JSON.stringify(entry);
      } else {
        const lastMessage = input.messages[input.messages.length - 1];
        raw = process.env.WRAP_TEST_RESPONSE ?? lastMessage?.content ?? "";
      }
      if (raw.startsWith("ERROR:")) throw new Error(raw.slice(6));
      if (!schema) return raw;
      return schema.parse(JSON.parse(raw));
    },
  };
}
