import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { getTheme, type ThemeTokens } from "../core/theme.ts";
import { interpolateGradient } from "./gradient.ts";
import {
  type AnimationFrame,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  FRAMES,
} from "./welcome-animation-frames.ts";

const START_HOLD_MS = 1000;
const FRAME_DURATION_SCALE = 1.5;

type Step = {
  nextIndex: number;
  delayMs: number;
} | null;

export function nextStep(index: number, frames: readonly AnimationFrame[]): Step {
  const lastIndex = frames.length - 1;
  if (lastIndex <= 0) return null;
  if (index >= lastIndex) return null;
  if (index <= 0) return { nextIndex: 1, delayMs: START_HOLD_MS };
  const delayMs = (frames[index]?.duration ?? 0) * FRAME_DURATION_SCALE;
  return { nextIndex: index + 1, delayMs };
}

// Palette anchored to canvas rows, not the brain's per-frame bounds — rows
// keep the same color across all frames so the brain doesn't shimmer as it grows.
export function brainRowColor(y: number, theme: ThemeTokens): string {
  return interpolateGradient(y, CANVAS_HEIGHT, theme.gradient.welcomeBrain);
}

export function WelcomeAnimation() {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const step = nextStep(frameIndex, FRAMES);
    if (!step) return;
    const id = setTimeout(() => setFrameIndex(step.nextIndex), step.delayMs);
    return () => clearTimeout(id);
  }, [frameIndex]);

  const theme = getTheme();
  const frame = FRAMES[frameIndex] ?? FRAMES[0];
  if (!frame) return null;

  return (
    <Box flexDirection="column" width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
      {frame.content.map((row, y) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable per-frame layout
        <Text key={y} color={brainRowColor(y, theme)}>
          {row}
        </Text>
      ))}
    </Box>
  );
}
