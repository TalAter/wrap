import type { Provider } from "../types.ts";

export function testProvider(): Provider {
  return {
    runPrompt: async (input, schema?) => {
      const lastMessage = input.messages[input.messages.length - 1];
      const raw = process.env.WRAP_TEST_RESPONSE ?? lastMessage?.content ?? "";
      if (!schema) return raw;
      return schema.parse(JSON.parse(raw));
    },
  };
}
