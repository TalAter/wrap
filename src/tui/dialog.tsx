import { Box, type DOMElement, Text, useBoxMetrics, useWindowSize } from "ink";
import { type ReactNode, type RefObject, useRef } from "react";
import type { Color } from "../core/ansi.ts";
import {
  type Badge,
  type BorderSegment,
  bottomBorderSegments,
  interpolateGradient,
  topBorderSegments,
} from "./border.ts";

const DIALOG_MARGIN = 4;
const MIN_TOTAL_WIDTH = 5;

/** Horizontal cells the dialog chrome adds on top of its inner content (borders + outer margin). */
export const DIALOG_CHROME_WIDTH = 4 + DIALOG_MARGIN;
/** Vertical cells the dialog chrome adds on top of its inner content (top/bottom border + top/bottom padding). */
export const DIALOG_CHROME_HEIGHT = 4;

/** Derive the inner content width for a dialog given terminal columns and natural content width. */
export function dialogInnerWidth(termCols: number, naturalContentWidth: number): number {
  const maxWidth = Math.max(MIN_TOTAL_WIDTH, termCols - DIALOG_MARGIN);
  const totalWidth = Math.min(naturalContentWidth + 4, maxWidth);
  return totalWidth - 4;
}

/**
 * Generic bordered-chrome dialog. Owns the terminal-centered outer layout,
 * width clamping, top/bottom borders (with optional badge + status), and
 * the left/right gradient bars sized to the measured inner content height.
 *
 * Knows nothing about what's inside — callers own the semantics and pass
 * primitive styling inputs (stops, badge) and their own children.
 */
type DialogProps = {
  /** Gradient ramp for the top border + left bar. */
  gradientStops: Color[];
  /** Optional badge embedded in the top border (e.g. risk level, wizard badge). */
  badge?: Badge;
  /** Status text threaded into the bottom border (spinner, loading message, etc.). */
  bottomStatus?: string;
  /**
   * Caller-computed max text width of the content. Dialog clamps this to
   * the terminal width and adds 4 cells of padding for the borders.
   */
  naturalContentWidth: number;
  children: ReactNode;
};

export function Dialog({
  gradientStops,
  badge,
  bottomStatus,
  naturalContentWidth,
  children,
}: DialogProps) {
  const { columns: termCols, rows: termRows } = useWindowSize();

  const innerWidth = dialogInnerWidth(termCols, naturalContentWidth);
  const totalWidth = innerWidth + 4;

  const middleRef = useRef<DOMElement>(null);
  const { height: measuredHeight } = useBoxMetrics(middleRef as RefObject<DOMElement>);
  const borderCount = Math.max(1, measuredHeight);

  const leftBorderLines = Array.from({ length: borderCount }, (_, index) => ({
    key: `left-${index}`,
    color: interpolateGradient(index, borderCount, gradientStops),
  }));
  const rightBorderLines = Array.from({ length: borderCount }, (_, index) => ({
    key: `right-${index}`,
  }));

  return (
    <Box width={termCols} height={termRows} justifyContent="center" alignItems="center">
      <Box flexDirection="column" width={totalWidth}>
        <BorderLine segments={topBorderSegments(totalWidth, gradientStops, badge)} />

        <Box flexDirection="row" alignItems="flex-start">
          <Box flexDirection="column" width={2}>
            {leftBorderLines.map((line) => (
              <Text key={line.key} color={line.color}>
                {"│ "}
              </Text>
            ))}
          </Box>

          <Box
            ref={middleRef}
            flexDirection="column"
            width={innerWidth}
            paddingTop={1}
            paddingBottom={1}
          >
            {children}
          </Box>

          <Box flexDirection="column" width={2}>
            {rightBorderLines.map((line) => (
              <Text
                key={line.key}
                color={interpolateGradient(
                  gradientStops.length - 1,
                  gradientStops.length,
                  gradientStops,
                )}
              >
                {" │"}
              </Text>
            ))}
          </Box>
        </Box>

        <BorderLine segments={bottomBorderSegments(totalWidth, gradientStops, bottomStatus)} />
      </Box>
    </Box>
  );
}

function BorderLine({ segments }: { segments: BorderSegment[] }) {
  return (
    <Text>
      {segments.map((segment) => (
        <Text
          key={segment.key}
          color={segment.color}
          backgroundColor={segment.backgroundColor}
          bold={segment.bold}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}
