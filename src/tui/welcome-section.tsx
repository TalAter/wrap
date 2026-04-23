import { Box, Text, useWindowSize } from "ink";
import { LOGO } from "../core/logo.ts";
import { getTheme, themeHex } from "../core/theme.ts";
import { ActionBar } from "./action-bar.tsx";
import { interpolateGradient } from "./border.ts";
import { DIALOG_CHROME_HEIGHT, DIALOG_CHROME_WIDTH, Dialog } from "./dialog.tsx";
import { useKeyBindings } from "./key-bindings.ts";
import { WelcomeAnimation } from "./welcome-animation.tsx";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./welcome-animation-frames.ts";
import { getWizardStops, WIZARD_CONTENT_WIDTH } from "./wizard-chrome.tsx";

type WelcomeSectionProps = {
  onDone: () => void;
  onCancel: () => void;
};

const ANIMATION_GAP = 4;
const ANIMATION_CONTENT_WIDTH = WIZARD_CONTENT_WIDTH + ANIMATION_GAP + CANVAS_WIDTH;
const ANIMATION_MIN_TERM_COLS = ANIMATION_CONTENT_WIDTH + DIALOG_CHROME_WIDTH;
const ANIMATION_MIN_TERM_ROWS = CANVAS_HEIGHT + DIALOG_CHROME_HEIGHT;

export function WelcomeSection({ onDone, onCancel }: WelcomeSectionProps) {
  const { columns, rows: termRows } = useWindowSize();
  const showAnimation = columns >= ANIMATION_MIN_TERM_COLS && termRows >= ANIMATION_MIN_TERM_ROWS;
  const contentWidth = showAnimation ? ANIMATION_CONTENT_WIDTH : WIZARD_CONTENT_WIDTH;

  useKeyBindings([
    { on: "escape", do: onCancel },
    { on: "return", do: onDone },
  ]);

  const theme = getTheme();
  const highlight = themeHex(theme.interactive.highlight);
  const success = themeHex(theme.select.selected);
  const logoRowColor = (i: number): string =>
    interpolateGradient(i, LOGO.length, theme.gradient.welcomeLogo);

  const textBlock = (
    <Box flexDirection="column">
      {LOGO.map((line, i) => (
        <Text key={line} bold color={logoRowColor(i)}>
          {line}
        </Text>
      ))}
      <Text>
        a cli with{" "}
        <Text color={highlight} bold>
          taste
        </Text>{" "}
        (yours)
      </Text>
      <Text> </Text>
      <Text> </Text>
      <Text>Quick one-time setup — pick your AI provider and a couple of preferences.</Text>
      <Text> </Text>
      <Text> </Text>
      <Text>
        ⏱︎ Takes <Text color={success}>~45 seconds.</Text>
      </Text>
      <Text> </Text>
    </Box>
  );

  const keyHints = (
    <ActionBar
      items={[
        { glyph: "⏎", label: "to continue", primary: true },
        { glyph: "Esc", label: "to cancel" },
      ]}
    />
  );

  const PAD_LEFT = 3;

  return (
    <Dialog gradientStops={getWizardStops()} naturalContentWidth={contentWidth}>
      {showAnimation ? (
        <Box flexDirection="row" height={CANVAS_HEIGHT}>
          <Box
            flexDirection="column"
            width={WIZARD_CONTENT_WIDTH}
            height={CANVAS_HEIGHT}
            paddingLeft={PAD_LEFT}
          >
            <Box flexGrow={1} flexDirection="column" justifyContent="center">
              {textBlock}
            </Box>
            {keyHints}
          </Box>
          <Box width={ANIMATION_GAP} />
          <WelcomeAnimation />
        </Box>
      ) : (
        <Box flexDirection="column" width={WIZARD_CONTENT_WIDTH} paddingLeft={PAD_LEFT}>
          {textBlock}
          <Text> </Text>
          {keyHints}
        </Box>
      )}
    </Dialog>
  );
}
