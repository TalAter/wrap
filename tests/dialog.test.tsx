import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { Dialog, ThemeProvider } from "wrap-core/tui";
import { stripAnsi } from "../src/core/ansi.ts";
import { DARK_THEME } from "../src/core/theme.ts";
import { getRiskPreset } from "../src/tui/risk-presets.ts";

function TP({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={DARK_THEME} nerdFonts={false}>
      {children}
    </ThemeProvider>
  );
}

const { stops: lowStops, pill: lowPill } = getRiskPreset("low");
const { stops: medStops, pill: medPill } = getRiskPreset("medium");

describe("Dialog (generic chrome)", () => {
  test("renders arbitrary children inside the bordered frame", () => {
    const { lastFrame } = render(
      <TP>
        <Dialog
          gradientStops={lowStops}
          top={{ segs: [lowPill], align: "right" }}
          naturalContentWidth={40}
        >
          <Text>hello wizard</Text>
        </Dialog>
      </TP>,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("hello wizard");
    expect(text).toContain("╭");
    expect(text).toContain("╯");
  });

  test("embeds the provided pill in the top border", () => {
    const { lastFrame } = render(
      <TP>
        <Dialog
          gradientStops={medStops}
          top={{ segs: [medPill], align: "right" }}
          naturalContentWidth={40}
        >
          <Text>body</Text>
        </Dialog>
      </TP>,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("medium risk");
  });

  test("renders without a pill when none is supplied", () => {
    const { lastFrame } = render(
      <TP>
        <Dialog gradientStops={medStops} naturalContentWidth={40}>
          <Text>plain</Text>
        </Dialog>
      </TP>,
    );
    const text = stripAnsi(lastFrame() ?? "");
    expect(text).toContain("plain");
    expect(text).not.toContain("medium risk");
  });

  test("renders the bottomStatus text in the bottom border", () => {
    const { lastFrame } = render(
      <TP>
        <Dialog
          gradientStops={lowStops}
          top={{ segs: [lowPill], align: "right" }}
          bottomStatus="Loading models list…"
          naturalContentWidth={40}
        >
          <Text>body</Text>
        </Dialog>
      </TP>,
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("Loading models list…");
  });
});
