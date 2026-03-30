# Discovery

> How Wrap learns about its environment: init probes, runtime tool probes, tool watchlist, CWD context, and LLM probes.

---

## Overview

Wrap has four discovery mechanisms, each operating at a different timescale:

| Mechanism | When | Persists | Cost | Status |
|-----------|------|----------|------|--------|
| **Init probes** | First run | Global memory facts | One-time LLM call | Implemented |
| **Tool probe** | Every invocation | No (ephemeral context) | ~5ms (local `which`) | Implemented |
| **CWD files** | Every invocation | No (ephemeral context) | Negligible (local readdir) | Not implemented |
| **LLM probes** | On-demand during query loop | Scoped memory facts (when appropriate) | 1 round per probe | Not implemented |

The **tool watchlist** (see section below) extends the tool probe over time — it's not a separate mechanism but a persistent layer that grows the set of tools the tool probe checks.

Init probes and tool probes are cheap pre-query setup. CWD files and LLM probes operate during the query itself. Over time, a frequently-used Wrap installation builds up rich scoped memory — a first invocation in a new project might need 1-2 LLM probes; subsequent invocations in the same project need zero.

The tool watchlist is a persistent extension of the tool probe. As the LLM discovers tool domains relevant to the user (image editing, video processing, PDF manipulation, etc.), it nominates tools to watch — and those tools are checked via `which` on every future invocation. This means Wrap's tool awareness grows organically to match the user's actual work, without requiring anyone to predefine categories or maintain static tool lists.

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

## Tool Watchlist

> **Status:** Not implemented. Depends on LLM probes (multi-round query loop).
>
> **Implementation touches:**
> - Response schema: add `watchlist_additions` field (`command-response.schema.ts`)
> - Tool probe: return structured data (available/unavailable lists), merge in watchlist (`init-probes.ts`)
> - Context formatting: render `## Detected tools` and `## Unavailable tools` sections from structured data (`format-context.ts`)
> - Watchlist storage: new `tool-watchlist.json` file in `WRAP_HOME`, read/write/validate functions
> - Query loop: persist `watchlist_additions` from LLM response to watchlist file (`query.ts`)
> - **Logging (see `specs/logging.md`):** add `tools_available`/`tools_unavailable` to invocation-level fields, add `watchlist_additions` to round fields. `probeTools()` must return structured data for both the prompt formatter and the logger to consume.

### Problem

The default `PROBED_TOOLS` list is static — a hand-picked set of ~30 common tools baked into the Wrap binary. This works for general-purpose tools (git, curl, docker), but misses entire domains that specific users care about. A graphic designer may use `sips`, `convert`, `pngquant`, `optipng`, `cwebp`. A data engineer may use `duckdb`, `csvkit`, `xsv`, `miller`. A sysadmin may use `htop`, `ncdu`, `lsof`, `ss`.

Today, when a user asks Wrap to do something in one of these domains, the LLM has to spend a probe round running `which` to check tool availability — every time, even if the user does this kind of work regularly. The LLM already has the world knowledge to know which tools are relevant to a task on a given OS, but that knowledge is lost after each invocation.

### Solution: LLM-Grown Tool Watchlist

Any LLM response (probe, command, or answer) can include a `watchlist_additions` field — a list of tool names that should be checked via `which` on every future invocation. These tools are saved to a persistent **tool watchlist** at `~/.wrap/tool-watchlist.json` (overridable via `WRAP_HOME`), separate from the hardcoded defaults.

On startup, `probeTools()` merges the default `PROBED_TOOLS` + the user's watchlist and runs a single `which` call for all of them. The result is the same `## Detected tools` / `## Unavailable tools` sections in the prompt. The LLM doesn't need to know which tools came from defaults vs. watchlist — it just sees what's available.

**Why "watchlist" and not "discovered tools":** the list contains tools we want to *repeatedly check*, not tools we've confirmed exist. A tool on the watchlist might not be installed — that's fine. Knowing "convert is not installed" is as useful as knowing "sips is installed" because it saves the LLM from probing.

### How It Grows

The watchlist grows through LLM responses — most commonly probes, but any response type can include `watchlist_additions`. When the LLM decides it needs to check tool availability for a task, it returns `watchlist_additions` alongside the probe command:

```json
{
  "type": "probe",
  "content": "which sips convert magick mogrify pngquant optipng cwebp",
  "watchlist_additions": ["sips", "convert", "magick", "mogrify", "pngquant", "optipng", "cwebp"],
  "risk_level": "low",
  "explanation": "Checking available image conversion tools"
}
```

Watchlist additions are written to `tool-watchlist.json` immediately when the response is parsed — before the probe command executes, consistent with how `memory_updates` are handled. The probe then runs, results are fed back to the LLM, and the LLM picks the best available tool for the final command. On every future invocation — even months later, even for unrelated queries — the `which` probe checks all of them. If the user later installs ImageMagick, the LLM will see it immediately without needing a probe round.

### Comprehensive Nominations (Avoiding Steering)

A critical prompt instruction: **when returning `watchlist_additions`, include all well-known tools for this task on this OS — not just the one you plan to use.**

Without this, a subtle problem arises. If the user asks to compress PNGs and the LLM only nominates `sips` (because it plans to use it), then on future invocations the LLM sees "sips is available" in the tools section but has no information about alternatives like `pngquant` or `optipng`. This creates an information asymmetry that steers the LLM toward the first tool it happened to try, even when better alternatives exist and are installed.

By nominating all reasonable candidates — `sips`, `convert`, `pngquant`, `optipng`, `cwebp` — the future probe results are balanced. The LLM sees which of these are actually installed and can make an informed choice every time.

This instruction must appear in two places: as a schema comment on `watchlist_additions` (guiding structured output) and in the system prompt instruction text (guiding behavior). Eval examples should reinforce it — probes that nominate a broad set of tools for the domain, not just one.

### Storage Format

`~/.wrap/tool-watchlist.json`:

```json
[
  {"tool": "sips", "added": "2026-03-21"},
  {"tool": "convert", "added": "2026-03-21"},
  {"tool": "magick", "added": "2026-03-21"},
  {"tool": "mogrify", "added": "2026-03-21"},
  {"tool": "pngquant", "added": "2026-03-21"},
  {"tool": "duckdb", "added": "2026-04-15"},
  {"tool": "xsv", "added": "2026-04-15"}
]
```

Each entry has a `tool` name and an `added` date (ISO 8601 date, not datetime — day granularity is sufficient). Deduplication on write — adding a tool that's already in the list is a no-op (the original `added` date is preserved). The file is created on first watchlist addition, not on init.

The `added` date enables future pruning — tools added long ago that were never nominated again and never found available are candidates for removal. Combined with the `tools_available`/`tools_unavailable` and `watchlist_additions` fields in the log (see `specs/logging.md`), this gives a complete picture of each tool's usefulness over time.

**Validation:** tool names must match `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (alphanumeric, dots, hyphens, underscores — matching valid binary names). Anything else is silently dropped. This prevents command injection since tool names are interpolated into the `which` shell command.

Keeping this separate from memory (`memory.json`) is intentional:
- Memory facts are scoped text shown to the LLM as context. Watchlist entries are tool names fed to `which`.
- Memory facts are filtered by CWD scope. Watchlist tools are always checked globally — a tool installed on the system is available regardless of CWD.
- Separate storage makes it easy to inspect, reset, or trim the watchlist without touching memory.

### Merge Logic in `probeTools()`

```
probeTools():
  tools = [...PROBED_TOOLS, ...loadWatchlist()]
  deduplicate tools
  run `which <all tools> 2>&1`
  split output into available (with paths) / unavailable (names only)
```

The split into available/unavailable happens in `probeTools()` — it returns structured data (not a raw string) so `formatContext` can render the two sections separately.

### Prompt Context Formatting

Currently, tools not found by `which` are listed inline as `<tool> not found`. With the watchlist potentially growing the list, a more token-efficient format:

**Available tools** — listed with full paths (as today):
```
## Detected tools
/opt/homebrew/bin/brew
/usr/bin/git
/usr/bin/sips
/opt/homebrew/bin/ffmpeg
```

**Unavailable tools** — grouped in a single line:
```
## Unavailable tools
apt, dnf, pacman, yum, convert, magick, mogrify, pngquant
```

This saves tokens compared to one `<tool> not found` line per missing tool, and the format is equally clear to the LLM.

### Schema Change

Add `watchlist_additions` to the response schema:

```typescript
watchlist_additions: z
  .array(z.string())
  .nullable()
  .optional()
  // Tool names to add to the persistent watchlist.
  // Checked via `which` on every future invocation.
  // When probing for tool availability, include ALL well-known tools
  // for this task on this OS — not just the one you plan to use.
  // This gives balanced visibility into what's installed.
```

This field can accompany any response type (probe, command, answer), though in practice it will almost always appear on probes. Example: the LLM returns a command using `sips` but also nominates the broader set of image tools for future awareness.

### Lifecycle

- **Creation:** first time the LLM returns `watchlist_additions` with at least one new tool.
- **Growth:** subsequent LLM responses with `watchlist_additions`. Deduped on write.
- **No shrinkage (v1):** tools are never removed automatically. A user can manually edit `tool-watchlist.json` to trim it. Future pruning can use log data: tools added long ago that were never nominated again by the LLM (no `watchlist_additions` referencing them) and never found available (`tools_unavailable` in every invocation) are safe to remove. See `specs/logging.md`.
- **Scale:** even at 150+ tools, a single `which` call completes in well under 50ms. Token cost is ~1 short line per tool. No practical ceiling for v1.

### Example: Full Flow

User's first image-related request:

```
$ w convert all gifs in this dir to pngs
```

**Round 1 — LLM returns a probe** (no image tools in detected tools yet):
```json
{
  "type": "probe",
  "content": "which sips convert magick mogrify pngquant optipng cwebp",
  "watchlist_additions": ["sips", "convert", "magick", "mogrify", "pngquant", "optipng", "cwebp"],
  "risk_level": "low",
  "explanation": "Checking available image conversion tools"
}
```

Wrap writes the seven tools (with today's date) to `tool-watchlist.json`, runs the probe, feeds output back.

**Round 2 — LLM sees probe results** (`sips` found, rest unavailable):
```json
{
  "type": "command",
  "content": "for f in *.gif; do sips -s format png \"$f\" --out \"${f%.gif}.png\"; done",
  "risk_level": "low",
  "explanation": "Convert each GIF to PNG using sips"
}
```

**Weeks later, unrelated request:**
```
$ w count lines in all python files
```

The `which` probe now checks default tools + `sips, convert, magick, mogrify, pngquant, optipng, cwebp`. The LLM sees `sips` in `## Detected tools` and `convert, magick, mogrify, pngquant, optipng, cwebp` in `## Unavailable tools`. This costs zero probe rounds. If the user later installs ImageMagick, `convert` and `magick` will appear in detected tools on the next run — the LLM notices immediately.

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
- **Tool probe + watchlist eliminate repeat tool-checking probes.** The LLM already knows which default tools are installed from the runtime tool probe. For domain-specific tools, the first probe grows the watchlist (see Tool Watchlist above) — subsequent invocations already have that information in the prompt.

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
