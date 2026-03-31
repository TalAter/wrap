# Discovery

> How Wrap learns about its environment: init probes, runtime tool probes, tool watchlist, CWD context, and LLM probes.

---

## Overview

Wrap has four discovery mechanisms, each operating at a different timescale:

| Mechanism | When | Persists | Cost | Status |
|-----------|------|----------|------|--------|
| **Init probes** | First run | Global memory facts | One-time LLM call | Implemented |
| **Tool probe + watchlist** | Every invocation | Watchlist persists | ~5ms (local `which`) | Implemented |
| **CWD files** | Every invocation | No (ephemeral context) | Negligible (local readdir) | Implemented |
| **LLM probes** | On-demand during query loop | Scoped memory facts (when appropriate) | 1 round per probe | Not implemented |

The **tool watchlist** (see section below) extends the tool probe over time — it's not a separate mechanism but a persistent layer that grows the set of tools the tool probe checks.

Init probes and tool probes are cheap pre-query setup. CWD files and LLM probes operate during the query itself. Over time, a frequently-used Wrap installation builds up rich scoped memory — a first invocation in a new project might need 1-2 LLM probes; subsequent invocations in the same project need zero.

The tool watchlist is a persistent extension of the tool probe. As the LLM discovers tool domains relevant to the user (image editing, video processing, PDF manipulation, etc.), it nominates tools to watch — and those tools are checked via `which` on every future invocation. This means Wrap's tool awareness grows organically to match the user's actual work, without requiring anyone to predefine categories or maintain static tool lists.

---

## Init Probes

> **Status:** Implemented. Code in `src/discovery/init-probes.ts`, `src/memory/init-prompt.ts`, `src/memory/memory.ts`.

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

> **Status:** Implemented.

Runs before every query. `probeTools()` merges `PROBED_TOOLS` + the tool watchlist, runs a single `which` call, and returns structured data: `{ available: string[], unavailable: string[] } | null`. Returns `null` if `which` fails entirely (tool context omitted from prompt).

Tool names (especially from the watchlist) are validated against `VALID_TOOL_NAME` (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`) before interpolation into the shell command.

Available tools are determined by parsing lines starting with `/` from `which` output. Unavailable tools are everything else — defined as "not in the available list" rather than regex on raw output. This handles all shells uniformly (bash silently omits missing tools, zsh/fish print "not found" messages).

### Why every run, not init?

Installed tools change over time (`brew install`, `apt install`). Version managers (nvm, fnm, pyenv) switch tool paths per directory. Storing tool availability as memory facts would go stale — a `which` call is ~5ms and always accurate.

### What gets probed

The `PROBED_TOOLS` array covers package managers (brew, apt, dnf, pacman, yum), core dev tools (git, docker, kubectl, python3, node, bun, curl, jq), modern CLI alternatives (tldr, rg, fd, bat, eza), and clipboard utilities (pbcopy, pbpaste, xclip, xsel, wl-copy, wl-paste).

### Prompt format

Two sections in the user message, rendered by `formatContext()`:

- **`## Detected tools`** — available tools listed with full paths (one per line). Full paths are an implicit signal about how tools were installed.
- **`## Unavailable tools`** — comma-separated single line. Token-efficient compared to one "not found" line per tool.

Either section is omitted when empty.

---

## Tool Watchlist

> **Status:** Implemented. Code in `src/discovery/watchlist.ts` (storage), `src/discovery/init-probes.ts` (merge into `probeTools`), `src/command-response.schema.ts` (`watchlist_additions` field), `src/core/query.ts` (persistence). Eval support in `eval/dspy/metric.py` and `eval/examples/seed.jsonl`.
>
> **Not yet wired to logging** — see `specs/logging.md` for the planned `tools_available`/`tools_unavailable` invocation-level fields and `watchlist_additions` round field.

### Why

The default `PROBED_TOOLS` list is static — ~30 common tools baked into the binary. This works for general-purpose tools but misses entire domains specific users care about (image editing, data processing, etc.). Without the watchlist, the LLM has to spend a probe round on `which` every time — even if the user does this kind of work regularly.

### Design

Any LLM response (probe, command, or answer) can include `watchlist_additions` — tool names to check via `which` on every future invocation. Stored in `~/.wrap/tool-watchlist.json`, separate from memory. On startup, `probeTools()` merges defaults + watchlist, runs a single `which`, and the LLM sees results in `## Detected tools` / `## Unavailable tools`.

**Why "watchlist" and not "discovered tools":** the list contains tools to *repeatedly check*, not tools confirmed to exist. Knowing "convert is not installed" saves a probe round just as much as knowing "sips is installed."

### Comprehensive Nominations (Avoiding Steering)

When returning `watchlist_additions`, the LLM must include **all well-known tools for the domain on this OS** — not just the one it plans to use. This instruction appears both as a schema comment and in eval examples.

Without this, the LLM would only nominate the tool it plans to use (e.g. `sips`), creating information asymmetry that steers future invocations toward that tool even when better alternatives exist and are installed. Nominating the full set (e.g. `sips`, `convert`, `pngquant`, `optipng`, `cwebp`) gives balanced visibility.

### Storage

`~/.wrap/tool-watchlist.json` — flat JSON array of `{tool, added}` entries. The `added` date (ISO 8601 day) is updated on each re-nomination, making it useful for future pruning (tools not nominated recently are candidates for removal). File is created on first watchlist addition, not on init. Tool names are validated against `VALID_TOOL_NAME` to prevent command injection.

Separate from memory intentionally: watchlist entries are tool names fed to `which` (always global), not scoped text shown to the LLM.

### Lifecycle

- **Creation:** first `watchlist_additions` with at least one new tool.
- **Growth:** subsequent responses with `watchlist_additions`. Re-nominations update the date.
- **No shrinkage (v1):** manual editing only. Future pruning can use the `added` date.
- **Scale:** even 150+ tools complete `which` in well under 50ms. No practical ceiling.

### Probe Content vs. Watchlist Additions

These serve different purposes and are often not the same list:

- **Probe content** is **tactical** — checks only what the LLM needs *right now* to answer the specific question. "Convert GIF to PNG" only needs `which sips convert magick`.
- **`watchlist_additions`** is **strategic** — nominates the full domain of tools the user might need in the future. "Convert GIF to PNG" suggests the user works with images, so nominate the whole image toolkit: `sips`, `convert`, `magick`, `mogrify`, `pngquant`, `optipng`, `cwebp`, `gifsicle`.

| Request | Probe (tactical) | Watchlist (strategic) |
|---------|-----------------|----------------------|
| "convert gif to png" | `which sips convert magick` | sips, convert, magick, mogrify, pngquant, optipng, cwebp, gifsicle |
| "compress this video" | `which ffmpeg handbrake` | ffmpeg, ffprobe, handbrake, x264, x265, av1an |
| "query this sqlite db" | `which sqlite3` | sqlite3, duckdb, csvkit, xsv, miller |

The `## Detected tools` section is computed once at startup and does **not** update mid-invocation. Within the same invocation, the LLM learns from its own probe output (conversation turns). On the next invocation, the watchlist kicks in and the LLM sees the updated tools without probing.

### Example Flow

This illustrates the full flow once LLM probes are implemented (see LLM Probes section below). Today, the watchlist storage and `watchlist_additions` persistence work — but the probe command itself won't execute until the multi-round query loop is built.

```
$ w convert all gifs in this dir to pngs
```

**Round 1** — No image tools in `## Detected tools`. LLM returns a tactical probe for conversion tools, plus a strategic watchlist nomination for the whole image domain:
```json
{
  "type": "probe",
  "content": "which sips convert magick",
  "watchlist_additions": ["sips", "convert", "magick", "mogrify", "pngquant", "optipng", "cwebp", "gifsicle"],
  "risk_level": "low",
  "explanation": "Checking available image conversion tools"
}
```

Wrap saves all eight tools to `tool-watchlist.json`, then runs `which sips convert magick`. The probe output (e.g. `/usr/bin/sips`) is fed back as a conversation turn.

**Round 2** — LLM sees probe output showing `sips` is available. Returns:
```json
{
  "type": "command",
  "content": "for f in *.gif; do sips -s format png \"$f\" --out \"${f%.gif}.png\"; done",
  "risk_level": "low",
  "explanation": "Convert each GIF to PNG using sips"
}
```

**Weeks later, any request** — `probeTools()` checks defaults + the eight image tools. The LLM sees `sips` in `## Detected tools` and the rest in `## Unavailable tools`. Zero probe rounds needed. If the user later installs `pngquant`, it appears in detected tools on the next run — the LLM can use it for PNG optimization without ever probing.

---

## CWD Files

> **Status:** Implemented. Code in `src/discovery/cwd-files.ts`, integrated via `src/main.ts` → `src/core/query.ts` → `src/llm/context.ts` → `src/llm/format-context.ts`. Eval support in `eval/bridge.ts` and `eval/dspy/optimize.py`; CWD-files-driven samples in `eval/examples/seed.jsonl`.

Every LLM request includes a listing of files in the current working directory. This gives the LLM immediate filesystem awareness without spending a probe round — it can see `package.json`, `Makefile`, `.eslintrc`, `node_modules/`, etc. and infer project tooling.

### Format

- `readdir` + `lstat` per entry (depth 1, includes dotfiles). Entries that fail to stat (broken symlinks, permission errors) are silently skipped.
- Hard cap at 50 entries. No exclusions — `node_modules/` appearing as a directory name is a useful signal.
- **Sort order:** oldest 20 (by mtime) + newest 30. This captures the skeleton files created at project init (package.json, Makefile, README) plus recently active files. If ≤50 total, include all sorted by mtime ascending.
- When truncated: a `... (N entries omitted) ...` gap line between the oldest and newest groups, plus a total count: `(showing 50 of 73 entries)`.
- Returns `undefined` for empty or unreadable directories (section omitted from prompt).

### Context Placement

Included in the user message as `## Files in CWD`, placed adjacent to the CWD line (after piped instruction, before `- Working directory`):

```
## Files in CWD
package.json
Makefile
README.md
.gitignore
src/
... (23 entries omitted) ...
tests/
node_modules/
.eslintrc.json
(showing 50 of 73 entries)
```

### Eval

New discovery features must be accompanied by eval support: the bridge must pass the new field through to `formatContext()`, the Python optimizer must accept it from samples and thread it through the full pipeline, and `seed.jsonl` should include samples that demonstrate the feature's effect on LLM behavior. See the CWD files implementation for the pattern.

### Future Enhancement Idea

Parse common config files and include a summary alongside the listing:
- `package.json` → script names
- `Makefile` → target names
- `Cargo.toml` → binary/workspace names

This would let the LLM skip a probe round that reads the file, at the cost of slightly more tokens per request.

---

## LLM Probes

> **Status:** Not implemented. Stub exists in `src/core/query.ts` (rejects probe responses with a message). Depends on the multi-round query loop (see `specs/SPEC.md` §6.3 and `specs/ARCHITECTURE.md` — Loop Rules). Implementation target: `src/core/query.ts`.

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
