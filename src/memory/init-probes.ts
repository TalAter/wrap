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

/**
 * Tools probed on every run via `which` as part of the tool probe
 */
export const PROBED_TOOLS: readonly string[] = [
  // Package managers
  "brew",
  "apt",
  "dnf",
  "pacman",
  "yum",
  // Core tools
  "git",
  "docker",
  "kubectl",
  "python3",
  "node",
  "bun",
  "curl",
  "jq",
  "tldr",
  "rg",
  "fd",
  "bat",
  "eza",
  // Clipboard
  "pbcopy",
  "pbpaste",
  "xclip",
  "xsel",
  "wl-copy",
  "wl-paste",
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

/**
 * Probe tool availability via a single `which` call.
 * Runs every startup (not just init) because installed tools may change
 * over time and differ by cwd (e.g. nvm, fnm version switching).
 * Returns the raw `which` output with "not found" appended for any
 * tools silently omitted (bash doesn't print missing tools).
 */
export function probeTools(): string {
  const result = Bun.spawnSync(["sh", "-c", `which ${PROBED_TOOLS.join(" ")} 2>&1`]);
  const output = result.stdout.toString().trim();

  // Some shells (bash) silently omit missing tools from `which` output.
  // Append explicit "not found" for any tool not mentioned.
  // Match tool at end of path (/<tool>) or start of line (alias/function/not-found)
  // to avoid false positives from tool names appearing in directory paths.
  const missing = PROBED_TOOLS.filter((tool) => {
    const re = new RegExp(`(/${tool}$|^${tool}\\b)`, "m");
    return !re.test(output);
  });
  const additions = missing.map((tool) => `${tool} not found`);

  return [output, ...additions].filter(Boolean).join("\n");
}
