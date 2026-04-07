export type ProbeCommand = { label: string; command: string };

export type ToolProbeResult = {
  available: string[];
  unavailable: string[];
};

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
  "wget",
  "jq",
  "tldr",
  "rg",
  "fd",
  "bat",
  "eza",
  // Text extraction (HTML → plain text, used for web reading probes)
  "textutil",
  "lynx",
  "w3m",
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

// Tool names are interpolated into a shell `which` command, so we must
// validate them to prevent command injection. extraTools comes from the
// persistent watchlist file, which a user (or a compromised LLM response)
// could fill with malicious strings like `; rm -rf /`.
export const VALID_TOOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Probe tool availability via a single `which` call.
 * Runs every startup (not just init) because installed tools may change
 * over time and differ by cwd (e.g. nvm, fnm version switching).
 * Returns structured data: available tools with full paths,
 * unavailable tools as bare names. Returns null if `which` fails entirely.
 */
export function probeTools(extraTools?: readonly string[]): ToolProbeResult | null {
  const allTools = extraTools ? [...new Set([...PROBED_TOOLS, ...extraTools])] : PROBED_TOOLS;
  const tools = allTools.filter((t) => VALID_TOOL_NAME.test(t));

  const result = Bun.spawnSync(["sh", "-c", `which ${tools.join(" ")} 2>&1`]);
  const output = result.stdout.toString().trim();

  // If which completely failed or returned nothing, skip tool context
  // rather than marking every tool as "not found".
  if (!output) return null;

  // Parse `which` output: lines starting with / are resolved paths.
  // Other lines are shell noise ("X not found", warnings, MOTD).
  const available = output.split("\n").filter((line) => line.startsWith("/"));

  // Unavailable = any tool not found in the available paths.
  // This handles all shells uniformly: bash silently omits missing tools,
  // zsh/fish print "X not found" — either way, if there's no path for it,
  // it's unavailable.
  const unavailable = tools.filter((tool) => !available.some((path) => path.endsWith(`/${tool}`)));

  return { available, unavailable };
}
