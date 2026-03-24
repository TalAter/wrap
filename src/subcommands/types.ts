export type SubcommandArg = {
  name: string;
  type: "number" | "string";
  required: boolean;
};

export type Subcommand = {
  flag: string;
  description: string;
  usage: string;
  arg?: SubcommandArg;
  run: (arg: string | number | null) => Promise<void>;
};
