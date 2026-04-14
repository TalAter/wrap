import { helpCmd } from "./help.ts";
import { logCmd } from "./log.ts";
import type { Command, Option } from "./types.ts";
import { versionCmd } from "./version.ts";

export const modelOption: Option = {
  kind: "option",
  flag: "--model",
  aliases: ["--provider"],
  id: "modelOverride",
  takesValue: true,
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
};

export const verboseOption: Option = {
  kind: "option",
  flag: "--verbose",
  id: "verbose",
  takesValue: false,
  description: "Enable debug output on stderr",
  usage: "w --verbose",
};

export const noAnimationOption: Option = {
  kind: "option",
  flag: "--no-animation",
  id: "noAnimation",
  takesValue: false,
  description: "Disable animations",
  usage: "w --no-animation",
};

export const commands: Command[] = [logCmd, helpCmd, versionCmd];
export const options: Option[] = [modelOption, verboseOption, noAnimationOption];
