import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { nextStep, WelcomeAnimation } from "../src/tui/welcome-animation.tsx";
import { FRAMES } from "../src/tui/welcome-animation-frames.ts";

const firstFrameData = FRAMES[0];
if (!firstFrameData) throw new Error("FRAMES is empty");
const firstFrameRow = (firstFrameData.content[5] ?? "").trimEnd();

describe("nextStep (ping-pong state machine)", () => {
  const lastIndex = FRAMES.length - 1;

  test("holds at frame 0 and kicks the sweep forward", () => {
    const step = nextStep(0, 1, FRAMES);
    expect(step).toEqual({ nextIndex: 1, nextDirection: 1, delayMs: 1000 });
  });

  test("holds at the last frame and reverses direction", () => {
    const step = nextStep(lastIndex, 1, FRAMES);
    expect(step).toEqual({ nextIndex: lastIndex - 1, nextDirection: -1, delayMs: 1000 });
  });

  test("mid-sweep forward advances by 1 after scaled duration", () => {
    const step = nextStep(3, 1, FRAMES);
    const expectedDelay = (FRAMES[3]?.duration ?? 0) * 1.5;
    expect(step).toEqual({ nextIndex: 4, nextDirection: 1, delayMs: expectedDelay });
  });

  test("mid-sweep backward steps backward by 1", () => {
    const step = nextStep(3, -1, FRAMES);
    const expectedDelay = (FRAMES[3]?.duration ?? 0) * 1.5;
    expect(step).toEqual({ nextIndex: 2, nextDirection: -1, delayMs: expectedDelay });
  });

  test("parks at index 0 when given a degenerate frame list", () => {
    expect(nextStep(0, 1, [])).toEqual({ nextIndex: 0, nextDirection: 1, delayMs: 1000 });
    expect(nextStep(0, 1, FRAMES.slice(0, 1))).toEqual({
      nextIndex: 0,
      nextDirection: 1,
      delayMs: 1000,
    });
  });

  test("a full ping-pong cycle visits every frame forward and back without landing on frame 0 mid-cycle", () => {
    const visited: number[] = [0];
    let index = 0;
    let direction: 1 | -1 = 1;
    // Step enough times to cross both boundaries at least once.
    for (let i = 0; i < lastIndex * 2 + 2; i++) {
      const step = nextStep(index, direction, FRAMES);
      index = step.nextIndex;
      direction = step.nextDirection;
      visited.push(index);
    }
    expect(visited).toContain(lastIndex);
    // Between reaching the last frame and returning to 0, we must NOT touch 0
    // (that would be a restart-loop, not ping-pong).
    const firstEnd = visited.indexOf(lastIndex);
    const nextZero = visited.indexOf(0, firstEnd);
    const between = visited.slice(firstEnd + 1, nextZero);
    expect(between).not.toContain(0);
    // And the backward sweep should include at least one mid-frame.
    expect(between.some((n) => n > 0 && n < lastIndex)).toBe(true);
  });
});

describe("WelcomeAnimation (render smoke)", () => {
  test("renders the first frame on mount", () => {
    const { lastFrame } = render(<WelcomeAnimation />);
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain(firstFrameRow);
  });
});
