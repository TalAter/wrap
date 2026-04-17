import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { nextStep, WelcomeAnimation } from "../src/tui/welcome-animation.tsx";
import { FRAMES } from "../src/tui/welcome-animation-frames.ts";

const firstFrameData = FRAMES[0];
if (!firstFrameData) throw new Error("FRAMES is empty");
const firstFrameRow = (firstFrameData.content[5] ?? "").trimEnd();

describe("nextStep (one-shot forward sweep)", () => {
  const lastIndex = FRAMES.length - 1;

  test("holds at frame 0 for 1000ms then advances to frame 1", () => {
    expect(nextStep(0, FRAMES)).toEqual({ nextIndex: 1, delayMs: 1000 });
  });

  test("mid-sweep advances by 1 after scaled duration", () => {
    const expectedDelay = (FRAMES[3]?.duration ?? 0) * 1.5;
    expect(nextStep(3, FRAMES)).toEqual({ nextIndex: 4, delayMs: expectedDelay });
  });

  test("stops at the last frame (no further step)", () => {
    expect(nextStep(lastIndex, FRAMES)).toBeNull();
  });

  test("returns null for degenerate frame lists", () => {
    expect(nextStep(0, [])).toBeNull();
    expect(nextStep(0, FRAMES.slice(0, 1))).toBeNull();
  });

  test("a full sweep visits every frame forward once and parks at the end", () => {
    const visited: number[] = [0];
    let index = 0;
    for (let i = 0; i < lastIndex + 5; i++) {
      const step = nextStep(index, FRAMES);
      if (!step) break;
      index = step.nextIndex;
      visited.push(index);
    }
    expect(visited[visited.length - 1]).toBe(lastIndex);
    expect(visited).toEqual(Array.from({ length: lastIndex + 1 }, (_, i) => i));
  });
});

describe("WelcomeAnimation (render smoke)", () => {
  test("renders the first frame on mount", () => {
    const { lastFrame } = render(<WelcomeAnimation />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain(firstFrameRow);
  });
});
