export type Subcommand = {
  flag: string;
  aliases?: string[];
  description: string;
  usage: string;
  help?: string;
  run: (args: string[]) => Promise<void>;
};
