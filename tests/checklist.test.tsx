import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { useState } from "react";
import { Checklist, type ChecklistItem } from "../src/tui/checklist.tsx";
import { seedTestConfig } from "./helpers.ts";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const ITEMS: ChecklistItem[] = [
  { type: "option", label: "Alpha", value: "a" },
  { type: "option", label: "Beta", value: "b" },
];

function Harness({
  initial,
  allowEmptySubmit,
  onSubmit,
}: {
  initial: Set<string>;
  allowEmptySubmit?: boolean;
  onSubmit: (values: string[]) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(initial);
  return (
    <Checklist
      items={ITEMS}
      checked={checked}
      allowEmptySubmit={allowEmptySubmit}
      onToggle={(v) =>
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(v)) next.delete(v);
          else next.add(v);
          return next;
        })
      }
      onSubmit={onSubmit}
    />
  );
}

beforeEach(() => {
  seedTestConfig();
});

describe("Checklist", () => {
  test("Enter with empty selection does nothing by default", async () => {
    let submitted: string[] | null = null;
    const { stdin } = render(
      <Harness initial={new Set()} onSubmit={(v) => (submitted = v)} />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(submitted).toBeNull();
  });

  test("Enter with a selection fires onSubmit", async () => {
    let submitted: string[] | null = null;
    const { stdin } = render(
      <Harness initial={new Set(["a"])} onSubmit={(v) => (submitted = v)} />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(submitted).toEqual(["a"]);
  });

  test("Enter with empty selection fires onSubmit([]) when allowEmptySubmit=true", async () => {
    let submitted: string[] | null = null;
    const { stdin } = render(
      <Harness
        initial={new Set()}
        allowEmptySubmit
        onSubmit={(v) => (submitted = v)}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(submitted).toEqual([]);
  });
});
