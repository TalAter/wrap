import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Color } from "../core/ansi.ts";
import { getTheme, LIGHT_THEME, themeHex } from "../core/theme.ts";
import {
  type AnimationFrame,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  FRAMES,
} from "./welcome-animation-frames.ts";

const BOUNDARY_HOLD_MS = 1000;
const FRAME_DURATION_SCALE = 1.5;

type PaletteKey = "c0" | "c1" | "c2" | "c3";

const PALETTES: Record<"dark" | "light", Record<PaletteKey, Color>> = {
  dark: {
    c0: [254, 184, 130],
    c1: [179, 109, 59],
    c2: [193, 137, 116],
    c3: [160, 82, 45],
  },
  light: {
    c0: [170, 70, 30],
    c1: [170, 70, 30],
    c2: [170, 70, 30],
    c3: [170, 70, 30],
  },
};

export type Direction = 1 | -1;

export type Step = {
  nextIndex: number;
  nextDirection: Direction;
  delayMs: number;
};

export function nextStep(
  index: number,
  direction: Direction,
  frames: readonly AnimationFrame[],
): Step {
  if (frames.length <= 1) {
    return { nextIndex: 0, nextDirection: direction, delayMs: BOUNDARY_HOLD_MS };
  }
  const current = frames[index];
  const lastIndex = frames.length - 1;
  const atStart = index <= 0;
  const atEnd = index >= lastIndex;
  if (atEnd) {
    return { nextIndex: lastIndex - 1, nextDirection: -1, delayMs: BOUNDARY_HOLD_MS };
  }
  if (atStart) {
    return { nextIndex: 1, nextDirection: 1, delayMs: BOUNDARY_HOLD_MS };
  }
  const delayMs = (current?.duration ?? 0) * FRAME_DURATION_SCALE;
  return { nextIndex: index + direction, nextDirection: direction, delayMs };
}

export function WelcomeAnimation() {
  const [frameIndex, setFrameIndex] = useState(0);
  const directionRef = useRef<Direction>(1);

  useEffect(() => {
    const step = nextStep(frameIndex, directionRef.current, FRAMES);
    const id = setTimeout(() => {
      directionRef.current = step.nextDirection;
      setFrameIndex(step.nextIndex);
    }, step.delayMs);
    return () => clearTimeout(id);
  }, [frameIndex]);

  const palette = useMemo<Record<PaletteKey, string>>(() => {
    const src = getTheme() === LIGHT_THEME ? PALETTES.light : PALETTES.dark;
    return {
      c0: themeHex(src.c0),
      c1: themeHex(src.c1),
      c2: themeHex(src.c2),
      c3: themeHex(src.c3),
    };
  }, []);
  const frame = FRAMES[frameIndex] ?? FRAMES[0];
  const rows = useMemo(() => frame?.content.map((r) => [...r]) ?? [], [frame]);
  if (!frame) return null;

  return (
    <Box flexDirection="column" width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
      {rows.map((row, y) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable per-frame layout
        <Box key={y}>
          {row.map((char, x) => {
            const key = `${x},${y}`;
            const fgKey = frame.fgColors[key] as "c0" | "c1" | "c2" | "c3" | undefined;
            const bgKey = frame.bgColors[key] as "c0" | "c1" | "c2" | "c3" | undefined;
            const fg = fgKey ? palette[fgKey] : undefined;
            const bg = bgKey ? palette[bgKey] : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable per-frame layout
              <Text key={x} color={fg} backgroundColor={bg}>
                {char}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
