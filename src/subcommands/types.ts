export type CLIFlag = {
  flag: string;
  aliases?: string[];
  id: string;
  description: string;
  usage: string;
  help?: string;
} & (
  | { kind: "command"; run: (args: string[]) => Promise<void> }
  | { kind: "option"; takesValue: boolean; env?: string[] }
);

export type Command = CLIFlag & { kind: "command" };
export type Option = CLIFlag & { kind: "option" };
