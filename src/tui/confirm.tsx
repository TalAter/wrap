import { Box, Text, useApp, useInput } from "ink";

type ConfirmPanelProps = {
  command: string;
  riskLevel: "medium" | "high";
  explanation?: string;
  onChoice: (choice: "run" | "cancel") => void;
};

export function ConfirmPanel({ command, riskLevel, explanation, onChoice }: ConfirmPanelProps) {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onChoice("cancel");
      exit();
    } else if (key.return) {
      onChoice("run");
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{command}</Text>
      <Text dimColor>{riskLevel} risk</Text>
      {explanation && <Text dimColor>{explanation}</Text>}
      <Text dimColor>[Enter] Run [q] Cancel</Text>
    </Box>
  );
}
