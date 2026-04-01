# Discovery

> How Wrap learns about its environment: init probes, runtime tool probes, tool watchlist, CWD context, and LLM probes.

---

## Overview

Wrap has four discovery mechanisms, each operating at a different timescale:

| Mechanism | When | Persists | Cost |
|-----------|------|----------|------|
| **Init probes** | First run | Global memory facts | One-time LLM call |
| **Tool probe + watchlist** | Every invocation | Watchlist persists | ~5ms (local `which`) |
| **CWD files** | Every invocation | No (ephemeral context) | Negligible (local readdir) |
| **LLM probes** | On-demand during query loop | Scoped memory facts (when appropriate) | 1 round per probe |

> **Status:** All four mechanisms are implemented.

The **tool watchlist** extends the tool probe over time — it's not a separate mechanism but a persistent layer that grows the set of tools the tool probe checks.

Init probes and tool probes are cheap pre-query setup. CWD files and LLM probes operate during the query itself. Over time, a frequently-used Wrap installation builds up rich scoped memory — a first invocation in a new project might need 1-2 LLM probes; subsequent invocations in the same project need zero.

The tool watchlist is a persistent extension of the tool probe. As the LLM discovers tool domains relevant to the user (image editing, video processing, PDF manipulation, etc.), it nominates tools to watch — and those tools are checked via `which` on every future invocation. This means Wrap's tool awareness grows organically to match the user's actual work, without requiring anyone to predefine categories or maintain static tool lists.

---

## Init Probes

> **Status:** Implemented.

On first run, Wrap probes the system locally (OS, shell, distro, config file locations), sends raw output to the LLM to parse into concise facts, and saves them as global (`/` scope) memory facts. See `specs/memory.md` for storage format and scoping.

Init only covers things that rarely change and benefit from LLM semantic parsing (e.g. inferring "macOS" from "Darwin", "Apple Silicon" from "arm64"). Tool availability is handled separately by the runtime tool probe.

The LLM parses raw probe output using a plain-text prompt (not the Zod command response schema) — one fact per line. If the LLM call fails → error and exit (if we can't reach the LLM for init, we can't reach it for the query either).

---

## Runtime Tool Probe

> **Status:** Implemented.

Runs before every query. Merges a static default list (`PROBED_TOOLS`) with the tool watchlist, runs a single `which` call, and returns `{ available, unavailable }` or `null` if `which` fails entirely (tool context is omitted from the prompt rather than sending garbage). Tool names are validated against a regex before shell interpolation to prevent command injection.

### Why every run, not init?

Installed tools change over time (`brew install`, `apt install`). Version managers (nvm, fnm, pyenv) switch tool paths per directory. Storing tool availability as memory facts would go stale — a `which` call is ~5ms and always accurate.

### What gets probed

Package managers (brew, apt, dnf, pacman, yum), core dev tools (git, docker, kubectl, python3, node, bun, curl, jq), modern CLI alternatives (tldr, rg, fd, bat, eza), and clipboard utilities (pbcopy, pbpaste, xclip, xsel, wl-copy, wl-paste).

### Prompt format

Two sections in the user message:

- **`## Detected tools`** — available tools listed with full paths (one per line). Full paths are an implicit signal about how tools were installed.
- **`## Unavailable tools`** — comma-separated single line. Token-efficient compared to one "not found" line per tool.

Either section is omitted when empty.

---

## Tool Watchlist

> **Status:** Implemented. Not yet wired to logging — see `specs/logging.md` for the planned `tools_available`/`tools_unavailable` invocation-level fields and `watchlist_additions` round field.

### Why

The default `PROBED_TOOLS` list is static — ~30 common tools baked into the binary. Without the watchlist, the LLM has to spend a probe round on `which` every time for domain-specific tools — even if the user does this kind of work regularly.

### Design

Any LLM response (probe, command, or answer) can include `watchlist_additions` — tool names to check via `which` on every future invocation. Stored in `~/.wrap/tool-watchlist.json`, separate from memory. On startup, the tool probe merges defaults + watchlist and runs a single `which`.

**Why "watchlist" and not "discovered tools":** the list contains tools to *repeatedly check*, not tools confirmed to exist. Knowing "convert is not installed" saves a probe round just as much as knowing "sips is installed."

### Comprehensive Nominations (Avoiding Steering)

When returning `watchlist_additions`, the LLM must include **all well-known tools for the domain on this OS** — not just the one it plans to use. This instruction appears both as a schema comment and in eval examples.

Without this, the LLM would only nominate the tool it plans to use (e.g. `sips`), creating information asymmetry that steers future invocations toward that tool even when better alternatives exist and are installed. Nominating the full set (e.g. `sips`, `convert`, `pngquant`, `optipng`, `cwebp`) gives balanced visibility.

### Storage

`~/.wrap/tool-watchlist.json` — flat JSON array of `{tool, added}` entries. The `added` date is updated on each re-nomination (useful for future pruning). File created on first addition, not on init. Tool names are validated to prevent command injection. Separate from memory: watchlist entries are tool names fed to `which` (always global), not scoped text shown to the LLM.

### Lifecycle

- **Growth:** LLM responses with `watchlist_additions`. Re-nominations update the date.
- **No shrinkage (v1):** manual editing only. Future pruning can use the `added` date.
- **Scale:** even 150+ tools complete `which` in well under 50ms.

### Probe Content vs. Watchlist Additions

- **Probe content** is **tactical** — checks only what the LLM needs *right now*. "Convert GIF to PNG" only needs `which sips convert magick`.
- **`watchlist_additions`** is **strategic** — nominates the full domain for future invocations. "Convert GIF to PNG" suggests the user works with images, so nominate: `sips`, `convert`, `magick`, `mogrify`, `pngquant`, `optipng`, `cwebp`, `gifsicle`.

The `## Detected tools` section is computed once at startup and does **not** update mid-invocation. Within the same invocation, the LLM learns from its own probe output. On the next invocation, the watchlist kicks in and the LLM sees the updated tools without probing.

### Example Flow

```
$ w convert all gifs in this dir to pngs
```

**Round 1** — No image tools in `## Detected tools`. LLM returns a tactical probe + strategic watchlist:
```json
{
  "type": "probe",
  "content": "which sips convert magick",
  "watchlist_additions": ["sips", "convert", "magick", "mogrify", "pngquant", "optipng", "cwebp", "gifsicle"],
  "risk_level": "low",
  "explanation": "Checking available image conversion tools"
}
```

Wrap saves all eight tools to the watchlist, runs the probe, feeds output (`/usr/bin/sips`) back as a conversation turn.

**Round 2** — LLM sees sips is available, produces the command.

**Weeks later** — `probeTools()` checks defaults + the eight image tools. The LLM sees `sips` in detected tools. Zero probe rounds needed. If the user later installs `pngquant`, it appears automatically.

---

## CWD Files

> **Status:** Implemented.

Every LLM request includes a listing of files in the current working directory (`## Files in CWD`). This gives the LLM immediate filesystem awareness without spending a probe round — it can see `package.json`, `Makefile`, `node_modules/`, etc. and infer project tooling.

**Format:** depth-1 readdir, hard cap at 50 entries (oldest 20 + newest 30 by mtime, with gap line when truncated). No exclusions — `node_modules/` as a directory name is a useful signal. Returns `undefined` for empty/unreadable directories (section omitted).

### Eval

New discovery features must be accompanied by eval support: the bridge must pass the new field through to `formatContext()`, the Python optimizer must thread it through the pipeline, and `seed.jsonl` should include samples demonstrating the feature's effect on LLM behavior. The CWD files implementation is the reference pattern.

### Future Enhancement Idea

Parse common config files and include a summary alongside the listing (`package.json` → script names, `Makefile` → target names). This would let the LLM skip a probe round that reads the file, at the cost of slightly more tokens per request.

---

## LLM Probes

> **Status:** Implemented. Core loop in `src/core/query.ts`. Prompt strings in `src/prompt.constants.json`. Config: `maxRounds`, `maxProbeOutputChars`. Eval support: `extra_messages` and `last_round` fields in bridge + optimizer + seed samples.

The LLM can return `type: "probe"` to run a safe, read-only discovery command before generating the final command. Probe results are fed back as conversation turns (assistant + user message pairs), building context across rounds.

### Behavior

- Probes execute silently (output captured, not shown on stdout)
- `🔍` indicator with explanation on stderr
- Probe results become conversation turns (multi-turn context)
- Probes count toward the unified round budget (`maxRounds`, configurable, default 5)
- Memory updates and watchlist additions from probe responses are persisted immediately (to disk)
- Probe output is capped at `maxProbeOutputChars` (configurable, default ~200KB) with a truncation note

### Safety

Probes must be `risk_level: "low"` — they are read-only discovery commands. If the LLM returns a non-low-risk probe:
1. **Retry once** (within the same round) with guidance that probes must be safe, read-only commands
2. **Refuse** if still non-low after retry — the probe is not executed, the LLM is told it was refused, and a round is consumed

### Conversation Structure

Each round appends to the same messages array. A probe round adds:
- Assistant turn: the probe response (full JSON)
- User turn: `## Probe output\n{captured stdout + stderr}`

Non-zero exit codes are included in the output. Context (memory, tools, CWD files) is assembled once before the loop and not rebuilt — the LLM already knows what it discovered.

### Tool Discovery

- **Prompt guidance is intentionally general.** The system prompt says "use a probe to gather more context first" without prescribing specific tactics. The LLM decides what to probe — `which`, `--help`, `cat`, filesystem listing, etc.
- **Few-shot examples** (via DSPy) are the primary mechanism for teaching discovery patterns.
- **Memory prevents redundant probing.** Discovered facts are saved to scoped memory and included in future requests.
- **Tool probe + watchlist eliminate repeat tool-checking probes.** The first probe grows the watchlist; subsequent invocations already have that information.

### Example Discovery Patterns

| Scenario | Likely probe(s) |
|----------|-----------------|
| "run the tests" | `cat package.json \| jq '.scripts'` or `cat Makefile` |
| "add an alias to my shell config" | `echo $SHELL`, `ls ~/.zshrc ~/.bashrc 2>/dev/null` |
| "show me my Claude skills" | `ls ~/.claude/` or `find ~/.claude -name '*.md'` |
| "deploy this" | `ls deploy* scripts/ bin/ 2>/dev/null` |

### Round Budget

Probes and error-fix rounds share a unified `maxRounds` budget. The LLM should be efficient:
- **Batch related checks:** `cat package.json | jq '.scripts'` gets everything in one round.
- **Leverage memory:** don't re-probe known facts.
- **Tool probe and CWD files often eliminate the need** for probe rounds entirely.

**Last-round constraint:** On the last available round, Wrap appends a "do not probe" instruction. This fires even when `maxRounds=1` (single-shot mode). The constraint only appears when it matters — no round-budget information is sent on earlier rounds.
