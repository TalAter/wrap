import { Box, type DOMElement, Text, useBoxMetrics, useWindowSize } from "ink";
import { type ReactNode, type RefObject, useRef } from "react";
import type { Color } from "../core/ansi.ts";
import { isNerdFonts } from "../core/output.ts";
import {
  type BorderSegment,
  bottomBorderSegments,
  fitTop,
  type TopBadge,
  topBorderSegments,
} from "./border.ts";
import { gradientRow, interpolateGradient } from "./gradient.ts";
import { pillWidth } from "./pill.tsx";

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

type DialogProps = {
  gradientStops: Color[];
  /** Dialog widens to fit the full pill; border falls back to narrow labels or drops it. */
  top?: TopBadge;
  bottomStatus?: string;
  naturalContentWidth: number;
  /** Static JSX, or a render-prop that receives the resolved innerWidth. */
  children: ReactNode | ((innerWidth: number) => ReactNode);
};

export function Dialog({
  gradientStops,
  top,
  bottomStatus,
  naturalContentWidth,
  children,
}: DialogProps) {
  const { columns: termCols, rows: termRows } = useWindowSize();
  const nerd = isNerdFonts();

  // Border = ╭ + dash + pill + dash + ╮ — 4 chrome cells around the pill body.
  const pillNatural = top ? pillWidth(top.segs, nerd, false) : 0;
  const effectiveNatural = Math.max(naturalContentWidth, pillNatural);
  const innerWidth = dialogInnerWidth(termCols, effectiveNatural);
  const totalWidth = innerWidth + 4;
  const prepared = fitTop(top, totalWidth - 4, nerd, pillNatural);

  const middleRef = useRef<DOMElement>(null);
  const { height: measuredHeight } = useBoxMetrics(middleRef as RefObject<DOMElement>);
  const borderCount = Math.max(1, measuredHeight);

  const rightColor = interpolateGradient(
    gradientStops.length - 1,
    gradientStops.length,
    gradientStops,
  );
  const leftLines = gradientRow(borderCount, gradientStops).map((color, i) => ({
    key: `left-${i}`,
    color,
  }));
  const rightLines = leftLines.map((_, i) => ({ key: `right-${i}` }));

  const body = typeof children === "function" ? children(innerWidth) : children;

  return (
    <Box width={termCols} height={termRows} justifyContent="center" alignItems="center">
      <Box flexDirection="column" width={totalWidth}>
        <BorderLine segments={topBorderSegments(totalWidth, gradientStops, prepared)} />

        <Box flexDirection="row" alignItems="flex-start">
          <Box flexDirection="column" width={2}>
            {leftLines.map((line) => (
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
            {body}
          </Box>

          <Box flexDirection="column" width={2}>
            {rightLines.map((line) => (
              <Text key={line.key} color={rightColor}>
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
