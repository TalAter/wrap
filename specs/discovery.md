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

---

## Web Reading

> **Status:** Not implemented.
>
> **Implementation touches:**
> - Prompt instruction: add grounding rule to `prompt.optimized.json` instruction text
> - Schema comment: note URL-fetching probes in the `probe` type description (`command-response.schema.ts`)
> - Tool probe defaults: add `textutil`, `lynx`, `w3m`, `wget` to `PROBED_TOOLS` (`init-probes.ts`)
> - Probe indicator: detect URL-fetching probes and show `🌐` instead of `🔍` on stderr (`query.ts`)
> - Eval: add probe-correctness samples for URL-reading scenarios (`seed.jsonl`)

### Problem

When the user's request involves a URL, the LLM answers from its training data instead of reading the actual content. Four failure modes:

1. **"Install X as explained here URL"** — the LLM ignores the URL and generates an install command from its weights. The instructions at the URL may differ from what the LLM assumes.
2. **"Install X as explained on its website"** — the LLM knows the URL from training data, generates an install command from memory, and never visits the site. It should resolve the URL from its knowledge *and then fetch it* to get current instructions. Training data goes stale — install methods change, URLs move, flags get deprecated.
3. **"What does this do: curl URL | sh"** — the LLM explains `curl` flags from memory instead of fetching and analyzing the actual script. The user wants to know what *this specific script* does.
4. **"Is this safe? curl URL | sh"** — the LLM gives a generic "pipe-to-sh is risky" answer instead of reading the script and providing a grounded safety assessment.

All four are cases where real content is accessible via a simple `curl` probe, and the LLM should fetch it before responding.

### Solution: The Grounding Rule

A prompt instruction that captures the spirit: **if you can read the real thing, read it instead of guessing.**

> When a URL's actual content would improve your response — whether to follow instructions, analyze a script, answer a question, or anything else — probe-fetch it. Your training data may be stale or wrong; the live content is the ground truth. This includes cases where you know a URL from training but the user didn't provide one explicitly. The only exception is when the URL is merely an argument to a command the user wants to run (e.g., "open URL", "ping URL") — then use it directly without fetching.

This is a **prompt-level behavior**, not a new mechanism. The LLM uses the existing probe system to `curl` URLs, and the existing multi-round loop feeds the content back. No new response types, no schema changes, no new code paths.

### When to Fetch vs. When Not To

The LLM judges this. No flags, no URL auto-detection. Prompt instructions + few-shot examples teach the boundary:

| Request | Fetch? | Why |
|---------|--------|-----|
| `install ollama per https://ollama.com` | Yes | User explicitly points to URL for instructions |
| `install ollama as explained on their site` | Yes | LLM resolves the URL from its knowledge, then fetches it for current instructions |
| `what does this script do: curl URL \| sh` | Yes | Question is about the content at the URL |
| `is this safe? curl URL \| sh` | Yes | Safety assessment requires reading the script |
| `summarize https://example.com/article` | Yes | Question is explicitly about URL content |
| `open https://github.com` | No | URL is an argument to `open` |
| `what does curl do` | No | Question about the `curl` command, not a URL |
| `ping example.com` | No | URL is a target for a command |

The user can always override by being explicit: "read https://example.com and tell me..." forces a fetch. No `--read` flag needed — natural language is the interface.

### HTML Extraction

Web pages return HTML. The LLM handles raw HTML fine — it can parse structure, extract text, ignore markup. The concern is **size**: a typical marketing page is 50-200KB of HTML.

**V1: LLM picks the extraction pipeline.** The LLM chooses the best tool chain based on what's available:

| Tool | Platform | Pipeline |
|------|----------|----------|
| `textutil` | macOS built-in | `curl -sL URL \| textutil -stdin -format html -convert txt -stdout` |
| `lynx` | Linux/macOS | `curl -sL URL \| lynx -stdin -dump` |
| `w3m` | Linux/macOS | `curl -sL URL \| w3m -dump -T text/html` |
| *(none)* | any | `curl -sL URL` (raw HTML fallback) |

To enable this, `textutil`, `lynx`, and `w3m` are added to the default `PROBED_TOOLS` array. The LLM sees which are available in `## Detected tools` and builds the appropriate pipeline. On macOS, `textutil` is always there. On Linux servers, `lynx` or `w3m` are common.

When no extraction tool is available, raw `curl` output still works — the LLM parses HTML natively. It's just more expensive in tokens. Probe output truncation (`maxProbeOutputChars`, ~200KB) prevents giant pages from blowing up context.

**Note on `curl -sL`:** The `-L` flag follows redirects (many sites redirect HTTP → HTTPS or www → non-www). The `-s` flag suppresses progress bars. These should be standard in URL-fetching probes. Few-shot examples should demonstrate this pattern.

### Future Enhancement: HTMLRewriter

Bun includes `HTMLRewriter` as a built-in global — zero dependencies, zero binary size increase. A future enhancement could auto-strip `<script>`, `<style>`, `<svg>`, `<noscript>` elements from probe output that looks like HTML, guaranteeing clean text on any platform without relying on external tools. Deferred — the LLM-picks-tool approach is simpler and sufficient for v1.

### Script Safety Analysis

When the user asks about a `curl URL | sh` pattern, the LLM should:

1. Probe-fetch the script (the URL in the `curl` command, not the page it redirects to)
2. Read the script content
3. Return a free-form `answer` grounded in the actual script

The LLM is prompted to **flag but not chase** secondary downloads: if the script contains `curl` or `wget` calls to download additional resources, the LLM should note this ("this script downloads a binary from X") but Wrap doesn't recursively fetch those URLs. The user sees what the top-level script does and can make an informed decision.

No structured safety template — the LLM responds in its natural voice. It will naturally cover what the script does, what it installs, what it modifies, and any concerns.

### Probe Indicator

URL-fetching probes display `🌐` on stderr instead of the default `🔍`:

```
🌐 Reading https://ollama.com/...
```

Detection: check if the probe's `content` field contains a URL pattern (starts with `curl` and includes `http://` or `https://`). Simple heuristic — doesn't need to be perfect. Fallback to `🔍` for ambiguous cases.

### Example Flows

**"Install as explained at URL":**

```
$ w install ollama as explained at https://ollama.com
🌐 Reading https://ollama.com/...
```

Round 1 — LLM probes:
```json
{
  "type": "probe",
  "content": "curl -sL https://ollama.com/ | textutil -stdin -format html -convert txt -stdout",
  "risk_level": "low",
  "explanation": "Reading installation instructions from ollama.com",
  "watchlist_additions": ["ollama"]
}
```

Round 2 — LLM sees the page content, finds the install command:
```json
{
  "type": "command",
  "content": "curl -fsSL https://ollama.com/install.sh | sh",
  "risk_level": "high",
  "explanation": "Official Ollama installer from their website. Downloads and runs a shell script."
}
```

Note: `watchlist_additions: ["ollama"]` persists immediately in round 1 — even if the command is refused, future invocations will check for `ollama` via `which`.

**"Is this safe?":**

```
$ w is this safe: curl -fsSL https://ollama.com/install.sh | sh
🌐 Fetching https://ollama.com/install.sh...
```

Round 1 — LLM probes the script:
```json
{
  "type": "probe",
  "content": "curl -sL https://ollama.com/install.sh",
  "risk_level": "low",
  "explanation": "Fetching the install script to analyze its contents"
}
```

Round 2 — LLM reads the script and answers:
```json
{
  "type": "answer",
  "content": "The script detects your OS and architecture, downloads the Ollama binary from GitHub releases, installs it to /usr/local/bin, and sets up a systemd service (Linux) or launchd plist (macOS). It runs `install -o0 -g0 -m755` which requires root — the script will prompt for sudo. It also downloads a second helper script from https://ollama.com/setup.sh for post-install configuration. No telemetry, no package manager hooks. Straightforward installer — the main risk is the pipe-to-sh pattern itself (MITM, CDN compromise)."
}
```

**"Summarize this page":**

```
$ w summarize https://example.com/blog/interesting-article
🌐 Reading https://example.com/blog/interesting-article...
```

Follows the same probe → answer flow. Wrap embraces this use case — it's a URL-grounded answerer when that's what the user needs.

### Dynamic Sites

Sites that require JavaScript rendering (SPAs, client-side-rendered pages) won't return useful content via `curl`. This is a known limitation shared by all non-browser HTTP clients. The LLM gets whatever the server returns for a plain HTTP request. Most documentation, install pages, and scripts are server-rendered and work fine.

### Eval

**Probe-correctness only.** Eval samples verify the LLM returns the right probe for URL-reading scenarios. Multi-turn eval (quality of the answer after getting content) is deferred.

Key eval samples needed:

| Prompt | Expected | Notes |
|--------|----------|-------|
| `install ollama as explained at https://ollama.com` | `type: "probe"`, content contains `curl` + `https://ollama.com` | Must probe-fetch, not answer from weights |
| `install ollama as explained on their website` | `type: "probe"`, content contains `curl` + `https://ollama.com` | LLM resolves URL from knowledge, then fetches — not just generates a command from memory |
| `what does this do: curl -fsSL https://ollama.com/install.sh \| sh` | `type: "probe"`, content fetches the `.sh` URL | Must fetch the script, not explain curl flags |
| `is this safe: curl URL \| sh` | `type: "probe"`, content fetches the script URL | Safety analysis requires reading the script |
| `summarize https://example.com/article` | `type: "probe"`, content fetches the URL | General URL grounding |
| `open https://github.com` | `type: "command"`, content is `open https://github.com` | URL is an argument — no fetching |
| `what does curl do` | `type: "answer"` | No URL to fetch — answer from weights |
| `ping example.com` | `type: "command"`, content is `ping example.com` | Not a fetch scenario |

### Prompt Changes

**System prompt instruction** — add to the behavioral rules in `prompt.optimized.json`:

> When a URL's actual content would improve your response — whether to follow instructions, analyze a script, answer a question, or anything else — probe-fetch it. Your training data may be stale or wrong; the live content is the ground truth. This includes cases where you know a URL from training but the user didn't provide one explicitly. The only exception is when the URL is merely an argument to a command the user wants to run (e.g., "open URL", "ping URL") — then use it directly without fetching.

**Schema comment** — update the `probe` type description in `command-response.schema.ts`:

> probe = a safe, read-only discovery command to learn about the user's environment (e.g. what shell they use, what's installed) **or to fetch URL content for grounded responses**. The probe output will be fed back to you in the next round so you can then produce the final command or answer.

### PROBED_TOOLS Additions

Add to the default `PROBED_TOOLS` array in `src/discovery/init-probes.ts`:

```typescript
// HTTP fetching
"wget",      // curl alternative (common on minimal Linux)
// Text extraction (for web reading probes)
"textutil",  // macOS built-in: HTML → plain text
"lynx",      // text browser: HTML → plain text
"w3m",       // text browser: HTML → plain text
```

These are always probed via `which` — the LLM sees their availability in `## Detected tools` and can build the right pipeline for clean URL content extraction.
