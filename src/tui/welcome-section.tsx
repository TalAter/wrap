import { Box, Text, useInput } from "ink";
import { Dialog } from "./dialog.tsx";
import { getWizardStops, KeyHints, WIZARD_CONTENT_WIDTH } from "./wizard-chrome.tsx";

type WelcomeSectionProps = {
  onDone: () => void;
  onCancel: () => void;
};

export function WelcomeSection({ onDone, onCancel }: WelcomeSectionProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.return) onDone();
  });

  return (
    <Dialog gradientStops={getWizardStops()} naturalContentWidth={WIZARD_CONTENT_WIDTH}>
      <Box flexDirection="column">
        <Text bold>Welcome to Wrap!</Text>
        <Text> </Text>
        <Text>Quick one-time setup — pick your AI provider and a couple of preferences.</Text>
        <Text> </Text>
        <Text>Takes ~45 seconds.</Text>
        <Text> </Text>
        <KeyHints
          items={[
            { combo: "⏎", label: "to continue", primary: true },
            { combo: "Esc", label: "to cancel" },
          ]}
        />
      </Box>
    </Dialog>
  );
}
