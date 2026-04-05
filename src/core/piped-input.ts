type StdinSource = {
  isTTY: boolean | undefined;
  read: () => Promise<string>;
};

const defaultStdin: StdinSource = {
  get isTTY() {
    return process.stdin.isTTY;
  },
  read: () => Bun.stdin.text(),
};

/** Read piped stdin content. Returns undefined when stdin is a TTY or content is empty. */
export async function readPipedInput(
  stdin: StdinSource = defaultStdin,
): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const content = await stdin.read();
  if (!/\S/.test(content)) return undefined;
  return content;
}
