/** System prompt sent to the LLM during memory initialization. */
export const INIT_SYSTEM_PROMPT = `You are analyzing raw output from system probe commands. Parse the results into concise, human-readable facts about the user's environment.

Rules:
- Respond with JSON: {"facts": ["...", "..."]} — one string per fact, nothing outside the JSON object
- Infer implicit facts (e.g., Darwin → macOS, arm64 → Apple Silicon)
- Include: OS + version + architecture, shell + config file location
- Be concise — each fact a single short sentence
- Do not include facts that cannot be determined from the probe output`;
