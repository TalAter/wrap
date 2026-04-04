import { Box, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";

type ConfirmPanelProps = {
  command: string;
  riskLevel: "medium" | "high";
  explanation?: string;
  onChoice: (choice: "run" | "cancel") => void;
};

export function ConfirmPanel({ command, riskLevel, explanation, onChoice }: ConfirmPanelProps) {
  const { exit } = useApp();
  const yPrimed = useRef(false);
  const [highState, setHighState] = useState<"idle" | "nudge" | "primed">("idle");

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onChoice("cancel");
      exit();
    } else if (key.return) {
      if (riskLevel === "medium" || yPrimed.current) {
        onChoice("run");
        exit();
      } else {
        setHighState("nudge");
      }
    } else if (riskLevel === "high" && input === "y") {
      yPrimed.current = true;
      setHighState("primed");
    }
  });

  const hints =
    riskLevel === "medium" || highState === "primed"
      ? "[Enter] Run [Esc] Cancel"
      : highState === "nudge"
        ? "[y] then [Enter] to run [Esc] Cancel"
        : "[y+Enter] Run [Esc] Cancel";

  return (
    <Box flexDirection="column">
      <Text>{command}</Text>
      <Text dimColor>{riskLevel} risk</Text>
      {explanation && <Text dimColor>{explanation}</Text>}
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
