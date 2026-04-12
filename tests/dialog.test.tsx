import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { stripAnsi } from "../src/core/ansi.ts";
import { Dialog } from "../src/tui/dialog.tsx";
import { RISK_PRESETS } from "../src/tui/risk-presets.ts";

const { stops: lowStops, badge: lowBadge } = RISK_PRESETS.low;
const { stops: medStops, badge: medBadge } = RISK_PRESETS.medium;

describe("Dialog (generic chrome)", () => {
  test("renders arbitrary children inside the bordered frame", () => {
    const { lastFrame } = render(
      <Dialog gradientStops={lowStops} badge={lowBadge} naturalContentWidth={40}>
        <Text>hello wizard</Text>
      </Dialog>,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("hello wizard");
    expect(text).toContain("╭");
    expect(text).toContain("╯");
  });

  test("embeds the provided badge in the top border", () => {
    const { lastFrame } = render(
      <Dialog gradientStops={medStops} badge={medBadge} naturalContentWidth={40}>
        <Text>body</Text>
      </Dialog>,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("medium risk");
  });

  test("renders without a badge when none is supplied", () => {
    const { lastFrame } = render(
      <Dialog gradientStops={medStops} naturalContentWidth={40}>
        <Text>plain</Text>
      </Dialog>,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("plain");
    expect(text).not.toContain("medium risk");
  });

  test("renders the bottomStatus text in the bottom border", () => {
    const { lastFrame } = render(
      <Dialog
        gradientStops={lowStops}
        badge={lowBadge}
        bottomStatus="Loading models list…"
        naturalContentWidth={40}
      >
        <Text>body</Text>
      </Dialog>,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("Loading models list…");
  });
});
