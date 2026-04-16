/**
 * Registry of user-settable values. Each entry declares which sources it
 * accepts (CLI flag, env var, config file) and its default. The resolver
 * reads these to merge user input with the canonical precedence:
 * CLI > env > file > default.
 *
 * Setting key === Config key by default. Exception: `model` is a virtual
 * setting — the resolver splits its value into `defaultProvider` and
 * `providers[x].model` rather than writing a `model` field.
 *
 * Entries may appear in any subset of {flag, env, config}. The CLI options
 * array is derived from entries that declare a `flag`.
 */

type BaseSetting = {
  description: string;
  usage?: string;
  help?: string;
  flag?: readonly string[];
  env?: readonly string[];
};

export type BooleanSetting = BaseSetting & { type: "boolean"; default?: boolean };
export type NumberSetting = BaseSetting & { type: "number"; default?: number };
export type StringSetting = BaseSetting & { type: "string"; default?: string };

export type Setting = BooleanSetting | NumberSetting | StringSetting;

export const SETTINGS = {
  verbose: {
    type: "boolean",
    description: "Enable debug output on stderr",
    usage: "w --verbose",
    flag: ["--verbose"],
    default: false,
  },
  yolo: {
    type: "boolean",
    description:
      "Skip confirmation dialogs — auto-execute all commands regardless of risk. All safety gates disabled.",
    usage: "w --yolo",
    flag: ["--yolo"],
    env: ["WRAP_YOLO"],
    default: false,
  },
  noAnimation: {
    type: "boolean",
    description: "Disable animations",
    usage: "w --no-animation",
    flag: ["--no-animation"],
    env: ["WRAP_NO_ANIMATION"],
    default: false,
  },
  model: {
    type: "string",
    description: "Override LLM provider/model",
    usage: "w --model <provider[:model]>",
    help: [
      "Override the LLM provider and/or model for this invocation.",
      "",
      "Formats:",
      "  provider:model   Use a specific provider and model",
      "  provider         Use a provider with its configured model",
      "  :model           Use the default provider with a different model",
      "  model            Smart match: check provider names, then model names",
      "",
      "The --provider flag is an alias for --model.",
    ].join("\n"),
    flag: ["--model", "--provider"],
    env: ["WRAP_MODEL"],
  },
  nerdFonts: {
    type: "boolean",
    description: "Use Nerd Font glyphs in terminal output",
    env: ["WRAP_NERD_FONTS"],
    default: false,
  },
  maxRounds: {
    type: "number",
    description: "Max LLM rounds per prompt before giving up",
    default: 5,
  },
  maxCapturedOutputChars: {
    type: "number",
    description: "Max chars of command output captured and sent back to the LLM",
    default: 200_000,
  },
  maxPipedInputChars: {
    type: "number",
    description: "Max chars of piped stdin forwarded to the LLM",
    default: 200_000,
  },
  defaultProvider: {
    type: "string",
    description: "Name of the provider used when --model has no provider prefix",
  },
} as const satisfies Record<string, Setting>;

export type SettingKey = keyof typeof SETTINGS;
