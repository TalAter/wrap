import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { type KeyBinding, useKeyBindings } from "../src/tui/key-bindings.ts";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function Harness({ bindings, isActive }: { bindings: readonly KeyBinding[]; isActive?: boolean }) {
  useKeyBindings(bindings, { isActive });
  return <Text>harness</Text>;
}

describe("useKeyBindings", () => {
  test("bare NamedKey fires on matching named key (escape)", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness bindings={[{ on: "escape", do: () => fired.push("esc") }]} />,
    );
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(fired).toEqual(["esc"]);
  });

  test("bare NamedKey return fires on enter", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness bindings={[{ on: "return", do: () => fired.push("ret") }]} />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(fired).toEqual(["ret"]);
  });

  test("bare single-char trigger fires on matching letter", async () => {
    const fired: string[] = [];
    const { stdin } = render(<Harness bindings={[{ on: "y", do: () => fired.push("y") }]} />);
    await wait();
    stdin.write("y");
    await wait();
    expect(fired).toEqual(["y"]);
  });

  test("char match is case-insensitive (shift+y → 'Y' matches 'y')", async () => {
    const fired: string[] = [];
    const { stdin } = render(<Harness bindings={[{ on: "y", do: () => fired.push("y") }]} />);
    await wait();
    stdin.write("Y");
    await wait();
    expect(fired).toEqual(["y"]);
  });

  test("bare single-char does NOT fire when ctrl is held", async () => {
    const fired: string[] = [];
    const { stdin } = render(<Harness bindings={[{ on: "c", do: () => fired.push("c") }]} />);
    await wait();
    // Ctrl+C sends ETX (0x03). Ink surfaces this as input="c" with key.ctrl=true.
    stdin.write("\x03");
    await wait();
    expect(fired).toEqual([]);
  });

  test("object trigger { key: 'c', ctrl: true } fires on ctrl+c", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness bindings={[{ on: { key: "c", ctrl: true }, do: () => fired.push("ctrl-c") }]} />,
    );
    await wait();
    stdin.write("\x03");
    await wait();
    expect(fired).toEqual(["ctrl-c"]);
  });

  test("array trigger fires on any member", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness bindings={[{ on: ["n", "escape"], do: () => fired.push("cancel") }]} />,
    );
    await wait();
    stdin.write("n");
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(fired).toEqual(["cancel", "cancel"]);
  });

  test("declaration order: first matching binding fires, rest skip", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness
        bindings={[
          { on: { key: "c", ctrl: true }, do: () => fired.push("cancel") },
          { on: "c", do: () => fired.push("copy") },
        ]}
      />,
    );
    await wait();
    // Plain c → copy only
    stdin.write("c");
    await wait();
    // Ctrl+c → cancel only
    stdin.write("\x03");
    await wait();
    expect(fired).toEqual(["copy", "cancel"]);
  });

  test("isActive: false suppresses all bindings", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness isActive={false} bindings={[{ on: "y", do: () => fired.push("y") }]} />,
    );
    await wait();
    stdin.write("y");
    await wait();
    expect(fired).toEqual([]);
  });

  test("arrow keys match named triggers", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness
        bindings={[
          { on: "left", do: () => fired.push("l") },
          { on: "right", do: () => fired.push("r") },
          { on: "up", do: () => fired.push("u") },
          { on: "down", do: () => fired.push("d") },
        ]}
      />,
    );
    await wait();
    stdin.write("\x1b[D"); // left
    await wait();
    stdin.write("\x1b[C"); // right
    await wait();
    stdin.write("\x1b[A"); // up
    await wait();
    stdin.write("\x1b[B"); // down
    await wait();
    expect(fired).toEqual(["l", "r", "u", "d"]);
  });

  test("space trigger fires on space char", async () => {
    const fired: string[] = [];
    const { stdin } = render(<Harness bindings={[{ on: "space", do: () => fired.push("sp") }]} />);
    await wait();
    stdin.write(" ");
    await wait();
    expect(fired).toEqual(["sp"]);
  });

  test("object trigger with shift-only modifier does not fire on plain key", async () => {
    const fired: string[] = [];
    const { stdin } = render(
      <Harness bindings={[{ on: { key: "a", shift: true }, do: () => fired.push("a") }]} />,
    );
    await wait();
    // Plain 'a' has no shift — should not fire.
    stdin.write("a");
    await wait();
    expect(fired).toEqual([]);
  });

  test("bare char does not fire when meta (alt) is held", async () => {
    const fired: string[] = [];
    const { stdin } = render(<Harness bindings={[{ on: "b", do: () => fired.push("b") }]} />);
    await wait();
    // Alt+b: ESC-b prefix is how many terminals encode meta. Ink sets key.meta.
    stdin.write("\x1bb");
    await wait();
    expect(fired).toEqual([]);
  });
});
