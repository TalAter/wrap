# Discovery

> How Wrap learns about its environment: init probes, runtime tool probes, CWD context, and LLM probes.

---

## Overview

Wrap has four discovery mechanisms, each operating at a different timescale:

| Mechanism | When | Persists | Cost | Status |
|-----------|------|----------|------|--------|
| **Init probes** | First run | Global memory facts | One-time LLM call | Implemented |
| **Tool probe** | Every invocation | No (ephemeral context) | ~5ms (local `which`) | Implemented |
| **CWD files** | Every invocation | No (ephemeral context) | Negligible (local readdir) | Not implemented |
| **LLM probes** | On-demand during query loop | Scoped memory facts (when appropriate) | 1 round per probe | Not implemented |

Init probes and tool probes are cheap pre-query setup. CWD files and LLM probes operate during the query itself. Over time, a frequently-used Wrap installation builds up rich scoped memory — a first invocation in a new project might need 1-2 LLM probes; subsequent invocations in the same project need zero.

---

## Init Probes

> **Status:** Implemented. Code in `src/memory/init-probes.ts`, `src/memory/init-prompt.ts`, `src/memory/memory.ts`.

On first run, Wrap probes the system locally (no LLM needed for the probes themselves), sends raw output to the LLM to parse into concise facts, and saves them as global (`/` scope) memory facts. See `specs/memory.md` for storage format and scoping.

### Probe Commands

Run locally via `Bun.spawnSync`, output concatenated as labeled sections:

| Probe | Command |
|-------|---------|
| OS | `uname -a` |
| Shell | `echo $SHELL` |
| Distro | `cat /etc/os-release 2>/dev/null \|\| echo "Not Linux"` |
| Shell config files | `ls -la ~/.*shrc ~/.*sh_profile ~/.*profile ~/.config/fish/config.fish 2>/dev/null` |

Init only covers OS, shell, distro, and config file locations — things that rarely change and benefit from LLM semantic parsing (e.g. inferring "macOS" from "Darwin", "Apple Silicon" from "arm64"). Tool availability is handled separately by the runtime tool probe.

### Init LLM Prompt

Uses `provider.runPrompt()` with a plain-text prompt (not the Zod command response schema). The LLM parses raw probe output into concise, human-readable facts — one fact per line. Response parsing: split by newlines, trim, filter empty, wrap each in `{fact: string}`.

### Init Flow

```
ensureMemory(provider, wrapHome)
  │
  ├─ memory.json exists and has at least one scope key?
  │    ──→ load and return Memory
  │
  └─ first run (file missing or empty map):
       ├─ run local probe commands: OS, shell, distro, config files (no LLM)
       ├─ show "✨ Learning about your system..." on stderr
       ├─ send raw probe output to LLM (plain text, one fact per line)
       ├─ wrap result as { "/": facts }
       ├─ save to memory.json
       ├─ show summary: "🧠 Detected OS and shell"
       └─ return Memory
```

If the LLM call fails → error and exit. If we can't reach the LLM for init, we can't reach it for the user's query either. Init always scopes facts to `/` (global) and uses its own plain-text prompt, not the Zod command response schema.

---

## Runtime Tool Probe

> **Status:** Implemented. Code in `src/memory/init-probes.ts` (`probeTools`, `PROBED_TOOLS`), injected via `src/main.ts` and `src/llm/context.ts`.

Runs before every query. `probeTools()` in `init-probes.ts`:

1. Runs a single `which` call for all tools in `PROBED_TOOLS` (package managers, dev tools, clipboard utilities)
2. Post-processes the output: any tool from the list not mentioned in the output gets `<toolname> not found` appended (handles shells like bash that silently omit missing tools)
3. Result is injected into the prompt as `## Detected tools`

If `which` fails entirely (empty output), the tool section is omitted from the prompt — Wrap continues without tool context rather than marking every tool as "not found". The LLM can always run its own `which` probes if needed.

### Why every run, not init?

Installed tools change over time (`brew install`, `apt install`). Version managers (nvm, fnm, pyenv) switch tool paths per directory. Storing tool availability as memory facts would go stale — a `which` call is ~5ms and always accurate.

### What gets probed

The `PROBED_TOOLS` array covers:

| Category | Tools |
|----------|-------|
| Package managers | brew, apt, dnf, pacman, yum |
| Core dev tools | git, docker, kubectl, python3, node, bun, curl, jq |
| Modern CLI alternatives | tldr, rg, fd, bat, eza |
| Clipboard utilities | pbcopy, pbpaste, xclip, xsel, wl-copy, wl-paste |

### Output format

The probed output preserves full paths (e.g. `/opt/homebrew/bin/python3`) — an implicit signal to the LLM about how tools were installed. Missing tools appear as `<toolname> not found`. This lets the LLM make informed choices: prefer `rg` over `grep` when available, use `pbcopy` on macOS vs `xclip` on Linux, etc.

---

## CWD Files

> **Status:** Not implemented. Implementation target: `src/llm/context.ts` (`assembleCommandPrompt`).

Every LLM request includes a listing of files in the current working directory. This gives the LLM immediate filesystem awareness without spending a probe round — it can see `package.json`, `Makefile`, `.eslintrc`, `node_modules/`, etc. and infer project tooling.

### Format

- Implementation: `ls -1a` (depth 1, includes dotfiles)
- Hard cap at 50 entries. No exclusions — `node_modules/` appearing as a directory name is a useful signal.
- **Sort order:** oldest 20 (by mtime) + newest 30. This captures the skeleton files created at project init (package.json, Makefile, README) plus recently active files. If ≤50 total, include all sorted by mtime ascending.
- If truncated, append total count: `(showing 50 of 73 entries)`

### Context Placement

Included in the user message as `## Files in CWD`:

```
## Files in CWD
package.json
Makefile
README.md
.gitignore
src/
...
tests/
node_modules/
.eslintrc.json
(showing 50 of 73 entries)
```

### Future Enhancement Idea

Parse common config files and include a summary alongside the listing:
- `package.json` → script names
- `Makefile` → target names
- `Cargo.toml` → binary/workspace names

This would let the LLM skip a probe round that reads the file, at the cost of slightly more tokens per request.

---

## Prompt Section Order

The user message assembles context sections in this order:

1. **Memory facts** — `## System facts`, then `## Facts about {path}` for matching scopes
2. **Detected tools** — `## Detected tools` (runtime `which` output)
3. **CWD** — `- Working directory (cwd): {path}` (+ `## Files in CWD` when listing is implemented)
4. **User's request** — `## User's request`

Piped input, when present, appears before the user's request (see `specs/piped-input.md`).

---

## LLM Probes

> **Status:** Not implemented. Depends on the multi-round query loop (see `specs/SPEC.md` §6.3 and `specs/ARCHITECTURE.md` — Loop Rules). Implementation target: `src/core/query.ts`.

The LLM can return `type: "probe"` to run a discovery command before generating the final command. Probe results are fed back as conversation turns, building context across rounds.

### Behavior

- Probes execute silently (output not shown on stdout)
- Subtle indicator on stderr: e.g., `🔍 Checking shell type...`
- Probe results become conversation turns (multi-turn context)
- Probes count toward the unified round budget (`maxRounds`, shared with error retries)
- The remaining round count is included in each LLM request so the LLM can make budget-aware decisions (see Round Budget below)
- The LLM may return `memory_updates` alongside any response to persist discoveries

### Tool Discovery

When the LLM encounters an unfamiliar tool, an uncertain flag, or a project-specific task:

- **Prompt guidance is intentionally general.** The system prompt says "use a probe to gather more context first" without prescribing specific discovery tactics. This lets the LLM use its judgment about what to probe — `--help`, `man`, `tldr`, filesystem listing, reading a config file, etc.
- **Few-shot examples** (via DSPy optimization) are the primary mechanism for teaching discovery patterns. Probe flow examples show the LLM how to discover project tooling, check available tools, and read config files.
- **Memory prevents redundant probing.** Once the LLM discovers something (tool installed, project uses bun), the fact is saved to scoped memory and included in future requests. No re-probing needed.
- **Tool probe eliminates tool-checking probes.** The LLM already knows which tools are installed from the runtime tool probe. It doesn't need to spend a round on `which pngquant sips convert` — that information is in the prompt.

### Example Discovery Patterns

These aren't prescriptive rules — they're examples of what good probe behavior looks like. The LLM should figure out the best strategy for each situation.

| Scenario | Likely probe(s) |
|----------|-----------------|
| "run the tests" | `cat package.json \| jq '.scripts'` or `cat Makefile` |
| "add an alias to my shell config" | `echo $SHELL`, `ls ~/.zshrc ~/.bashrc 2>/dev/null` |
| "show me my Claude skills" | `ls ~/.claude/` or `find ~/.claude -name '*.md'` |
| "deploy this" | `ls deploy* scripts/ bin/ 2>/dev/null` |

### Handling Flag/Syntax Errors

When a command fails with wrong flags or syntax, the error output (stderr) is sent to the LLM in the next round for auto-fix. Most tools already include usage help in their error messages (e.g., `grep: unrecognized option` prints the valid flags). The LLM often has enough context from the error alone to generate a corrected command.

If the error is cryptic, the LLM can spend a probe round on `<tool> --help` or `tldr <tool>` (if installed — known from the tool probe) to learn the correct flags. This is the LLM's decision within the round budget — Wrap doesn't auto-enrich errors with help output.

### Round Budget

LLM probes consume rounds from the unified `maxRounds` budget. The LLM should be efficient:
- **Batch related checks:** `cat package.json | jq '.scripts'` gets everything in one round.
- **Leverage memory:** don't re-probe known facts.
- **Tool probe and CWD files often eliminate the need** for "what's installed" and "what files exist" probes.
- **Reserve the last round for a command or answer.** If only one round remains in the budget, the LLM must not spend it on a probe. On the last round, Wrap appends an instruction to the prompt: do not probe, respond with a command or answer. This avoids polluting every request with round-budget explanations — the constraint only appears when it matters.
