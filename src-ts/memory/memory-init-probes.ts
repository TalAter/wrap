export type ProbeCommand = { label: string; command: string };

/**
 * Probe commands sent to the init LLM for semantic parsing.
 */
export const PROBE_COMMANDS: readonly ProbeCommand[] = [
  { label: "OS", command: "uname -a" },
  { label: "Shell", command: "echo $SHELL" },
  { label: "Distro", command: "cat /etc/os-release 2>/dev/null || echo 'Not Linux'" },
  {
    label: "Shell config files",
    command: "ls -la ~/.*shrc ~/.*sh_profile ~/.*profile ~/.config/fish/config.fish 2>/dev/null",
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
