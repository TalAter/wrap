/** System prompt sent to the LLM during memory initialization. */
export const INIT_SYSTEM_PROMPT = `You are analyzing raw output from system probe commands. Parse the results into concise, human-readable facts about the user's environment.

Rules:
- Return one fact per line, plain text (not JSON, not markdown)
- Infer implicit facts (e.g., Darwin → macOS, arm64 → Apple Silicon)
- Include: OS + version + architecture, shell + config file location, package manager, list of installed tools from the probe
- Be concise — each fact should be a single short line
- Do not include facts that cannot be determined from the probe output
- Do not add bullet points or numbering`;
