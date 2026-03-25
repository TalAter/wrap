export type Subcommand = {
  flag: string;
  description: string;
  usage: string;
  run: (args: string[]) => Promise<void>;
};
