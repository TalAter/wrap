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

/** Read piped stdin content. Returns null when stdin is a TTY or content is empty. */
export async function readPipedInput(stdin: StdinSource = defaultStdin): Promise<string | null> {
  if (stdin.isTTY) return null;
  const content = await stdin.read();
  if (!content.trim()) return null;
  return content;
}
