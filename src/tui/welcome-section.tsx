import { Box, Text, useInput, useWindowSize } from "ink";
import { DIALOG_CHROME_HEIGHT, DIALOG_CHROME_WIDTH, Dialog } from "./dialog.tsx";
import { WelcomeAnimation } from "./welcome-animation.tsx";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./welcome-animation-frames.ts";
import { getWizardStops, KeyHints, WIZARD_CONTENT_WIDTH } from "./wizard-chrome.tsx";

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

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.return) onDone();
  });

  const textBlock = (
    <Box flexDirection="column">
      <Text bold>Welcome to Wrap!</Text>
      <Text> </Text>
      <Text>Quick one-time setup — pick your AI provider and a couple of preferences.</Text>
      <Text> </Text>
      <Text>Takes ~45 seconds.</Text>
    </Box>
  );

  const keyHints = (
    <KeyHints
      items={[
        { combo: "⏎", label: "to continue", primary: true },
        { combo: "Esc", label: "to cancel" },
      ]}
    />
  );

  return (
    <Dialog gradientStops={getWizardStops()} naturalContentWidth={contentWidth}>
      {showAnimation ? (
        <Box flexDirection="row" height={CANVAS_HEIGHT}>
          <Box flexDirection="column" width={WIZARD_CONTENT_WIDTH} height={CANVAS_HEIGHT}>
            <Box flexGrow={1} flexDirection="column" justifyContent="center">
              {textBlock}
            </Box>
            {keyHints}
          </Box>
          <Box width={ANIMATION_GAP} />
          <WelcomeAnimation />
        </Box>
      ) : (
        <Box flexDirection="column" width={WIZARD_CONTENT_WIDTH}>
          {textBlock}
          <Text> </Text>
          {keyHints}
        </Box>
      )}
    </Dialog>
  );
}
