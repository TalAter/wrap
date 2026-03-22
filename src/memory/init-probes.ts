import { basename } from "node:path";

export type ProbeCommand = { label: string; command: string };

/** Probe commands run locally to detect the user's environment. */
export const PROBE_COMMANDS: readonly ProbeCommand[] = [
  { label: "OS", command: "uname -a" },
  { label: "Shell", command: "echo $SHELL" },
  { label: "Distro", command: "cat /etc/os-release 2>/dev/null || echo 'Not Linux'" },
  {
    label: "Shell config files",
    command:
      "ls -la ~/.*shrc ~/.*sh_profile ~/.*profile ~/.config/fish/config.fish 2>/dev/null",
  },
  { label: "Package manager", command: "which brew apt dnf pacman yum 2>/dev/null" },
  {
    label: "Core tools",
    command: "which git docker kubectl python3 node bun curl jq 2>/dev/null",
  },
];

/** Run all probe commands and concatenate output as labeled sections. */
export function runProbes(): string {
  const sections: string[] = [];

  for (const probe of PROBE_COMMANDS) {
    const result = Bun.spawnSync(["sh", "-c", probe.command]);
    const output = result.stdout.toString().trim();
    sections.push(`## ${probe.label}\n${output || "(no output)"}`);
  }

  return sections.join("\n\n");
}

/** Extract tool basenames from `which` output. Skips "not found" and blank lines. */
export function parseDetectedTools(whichOutput: string): string[] {
  return whichOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("not found") && line.includes("/"))
    .map((line) => basename(line));
}
