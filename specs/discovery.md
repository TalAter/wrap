# Discovery

> How Wrap learns about its environment: init probes, tool probes, tool watchlist, CWD files, and LLM probes.

See `specs/SPEC.md` §Glossary for canonical definitions of each term.

---

## Overview

Four discovery mechanisms, each at a different timescale:

| Mechanism | When | Persists | Cost |
|-----------|------|----------|------|
| Init probes | First run | Global memory facts | One-time LLM call |
| Tool probe + watchlist | Every invocation | Watchlist persists | ~5ms (`which`) |
| CWD files | Every invocation | No (ephemeral context) | Negligible (local readdir) |
| Non-final steps | On-demand during query loop | Scoped memory facts when appropriate | 1 round per step |

Init and tool probes are cheap pre-query setup. CWD files and non-final steps operate during the query itself. A frequently-used install builds up rich scoped memory — a first invocation in a new project might need 1–2 non-final steps, subsequent ones zero.

The tool watchlist is not a separate mechanism but a persistent layer that grows the set of tools the tool probe checks. As the LLM encounters new domains (image editing, video, PDFs) it nominates tools; future invocations `which` them automatically. Awareness grows organically to match the user's work without predefined categories or static lists.

---

## Init Probes

On first run, Wrap probes locally (OS, shell, distro, shell config files), sends raw output to the LLM to parse into concise facts, and saves them as global (`/` scope) memory. See `specs/memory.md` for scoping.

**Why LLM parsing.** Init covers things that rarely change and benefit from semantic interpretation — "Darwin" → "macOS", "arm64" → "Apple Silicon". Tool availability is deliberately *not* in init (see below).

**Plain-text prompt, not the command schema.** The init LLM call returns one fact per line — it's a parsing task, not a command generation task, so the Zod response schema doesn't apply.

**Fail closed.** If the init LLM call fails → error and exit. If we can't reach the LLM for init, we can't reach it for the query either, so there's no point pretending otherwise.

---

## Tool Probe

Runs before every query. Merges the static `PROBED_TOOLS` default list with the tool watchlist, runs a single `which`, and returns `{ available, unavailable }` — or `null` if `which` fails entirely (the section is then omitted rather than sent as garbage).

**Why every run, not init.** Installed tools change (`brew install`, `apt install`), and version managers (nvm, fnm, pyenv) switch paths per directory. Persisting tool facts would go stale; `which` is ~5ms and always accurate.

**What's in `PROBED_TOOLS`.** Package managers, core dev tools, modern CLI alternatives, HTML→text extractors for web reading, and clipboard utilities. See `src/discovery/init-probes.ts` for the current list.

**Prompt format.**
- `## Detected tools` — available tools with full paths, one per line. The path is an implicit signal about install method.
- `## Unavailable tools` — comma-separated single line. Token-efficient versus one "not found" line per tool.
- Either section is omitted when empty.

**Parsing `which`.** Lines beginning with `/` are resolved paths; everything else (shell noise, "not found" messages, MOTD) is ignored. This is shell-uniform: bash silently omits missing tools, zsh/fish print messages, but only real paths matter.

**Injection safety.** Tool names are validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` before being interpolated into the `which` command. The watchlist file is a persistence point a compromised LLM response or a user edit could poison, so validation is load-bearing.

---

## Tool Watchlist

### Why

`PROBED_TOOLS` is static — ~30 tools baked in. Without the watchlist, the LLM burns a probe round on `which` every time for domain-specific tools, even for work the user does regularly.

### Design

Any LLM response (non-final step, command, or reply) may include `watchlist_additions` — tool names to `which` on every future invocation. Stored in `~/.wrap/tool-watchlist.json` as a flat array of `{tool, added}` entries. The `added` date is refreshed on each re-nomination (for future pruning). The tool probe merges defaults + watchlist into one `which` call on startup.

**Name: "watchlist" not "discovered tools".** The list holds tools to *repeatedly check*, not tools confirmed to exist. "`convert` is not installed" saves a probe round just as much as "`sips` is installed."

**Separate from memory.** Watchlist entries are tool names fed to `which` (always global), not scoped text shown to the LLM. Different lifecycle, different storage.

### Comprehensive Nominations (Avoiding Steering)

When returning `watchlist_additions`, the LLM must nominate **all well-known tools for the domain on this OS**, not just the one it plans to use. Enforced via schema comment and eval examples.

**Why.** If the LLM only nominated the tool it picked (e.g. `sips`), future invocations would only ever see `sips` in `## Detected tools` — creating information asymmetry that steers subsequent runs toward that tool even when better alternatives (e.g. `pngquant` for lossy PNG) are installed. Nominating the full domain (`sips`, `convert`, `magick`, `pngquant`, `optipng`, `cwebp`, …) gives balanced visibility.

### Step Content vs Watchlist Additions

Two different axes:

- **Step content is tactical** — check only what's needed *now*. "Convert GIF to PNG" → `which sips convert magick`.
- **`watchlist_additions` is strategic** — nominate the full domain for future runs. Same request → the broader image-tool set.

The tool probe runs once at startup and does not re-run mid-invocation. Within a single invocation, the LLM learns from its own step output; on the next invocation, the watchlist surfaces everything without any step at all.

### Lifecycle

- **Growth:** LLM `watchlist_additions`. Re-nominations refresh `added`.
- **No shrinkage (v1):** manual edit only. Future pruning can key off `added` date.
- **Scale:** even 150+ tools complete in one `which` call in well under 50ms.

---

## CWD Files

Every LLM request includes a listing of the current working directory under `## Files in CWD`. Immediate filesystem awareness without spending a probe round — the LLM sees `package.json`, `Makefile`, `node_modules/`, etc. and infers project tooling.

**Format.** Depth-1 readdir, sorted by mtime. Hard cap of 50 entries: oldest 20 + newest 30 when truncated, with a gap marker and a "(showing X of Y)" footer. No exclusions — a `node_modules/` directory *is* a useful signal. Empty/unreadable directories → section omitted.

**Why oldest + newest.** Pure newest misses stable project files (lockfiles, config) that haven't been touched recently. Pure oldest misses active work. Splitting captures both.

**No globbing / no content reads in v1.** A future enhancement could parse common config files and include a summary (`package.json` → script names, `Makefile` → targets) to skip a probe round at the cost of more tokens per request. Deferred.

---

## Non-Final Steps

The LLM can return `type: "reply"` with `final: false` to run a safe read-only discovery command before generating the final command. Step results are appended to the conversation as assistant+user turn pairs, building context across rounds.

Core loop in `src/core/runner.ts`; `runRound` in `src/core/round.ts`; semantic transcript in `src/core/transcript.ts`. Prompt strings in `src/prompt.constants.json`. Config: `maxRounds`, `maxProbeOutputChars`.

### Behavior

- Non-final steps execute silently — output captured, never written to stdout.
- Status indicator on stderr: `🔍` (default) or `🌐` for URL fetches (see Web Reading).
- Non-final steps count against the unified `maxRounds` budget (default 5) shared with error-fix rounds.
- Memory updates and `watchlist_additions` from step responses are persisted immediately, so interruption doesn't lose work.
- Step output is truncated at `maxProbeOutputChars` (~200KB default) with a truncation note. Keeps pathological commands from blowing out context.

### Safety

Non-final steps must be `risk_level: "low"` — read-only by definition.

1. **Retry once** within the same round with guidance that non-final steps must be safe read-only commands.
2. **Refuse** if still non-low — step not executed, LLM told it was refused, round consumed.

The round cost on refusal is intentional: it prevents infinite adversarial retries and makes the LLM conservative about what it labels a non-final step.

### Conversation Structure

Each round appends to a single messages array. A non-final step round adds:
- Assistant turn: the step response JSON.
- User turn: `## Step output\n{captured stdout + stderr}`.

Non-zero exits are included in the output (the LLM often needs the error to decide next steps). Context (memory, tools, CWD files) is assembled once before the loop — not rebuilt per round, because the LLM already knows what it discovered.

### Tool Discovery Philosophy

- **Prompt guidance is intentionally general.** The system prompt says "use a non-final step to gather more context first" without prescribing `which` / `--help` / `cat` / etc. Tactics are learned from few-shot examples, not hardcoded.
- **Few-shot examples (DSPy) are the primary teaching mechanism.** Discovery patterns (`cat package.json | jq '.scripts'` for "run the tests", shell-config lookup for "add an alias", etc.) live in eval samples, not the prompt.
- **Memory prevents redundant steps.** Discovered facts are saved to scoped memory and included in future requests.
- **Tool probe + watchlist eliminate repeat tool-checking steps.** First step grows the watchlist; subsequent invocations already have the info.

### Round Budget

Non-final steps and error-fix rounds share `maxRounds`. The LLM is pushed to be efficient:
- Batch related checks into one command (`cat package.json | jq '.scripts'`).
- Don't re-run known facts.

**Last-round constraint.** On the final available round, Wrap appends a "must be final" instruction. This fires even at `maxRounds=1` (single-shot mode). The constraint only appears when it matters — no round-budget info leaks into earlier rounds, to avoid biasing behavior when budget is plentiful.

---

## Web Reading

URL-fetching reuses the non-final step loop — no new response type, no schema changes. Detection via `fetchesUrl()` in `src/core/runner.ts`, HTML extraction tools (`wget`, `textutil`, `lynx`, `w3m`) in `PROBED_TOOLS`, grounding rule in the system prompt (mirrored in the DSPy seed).

### Problem

When a request involves a URL, LLMs tend to answer from training data instead of reading the actual content. Four failure modes:

1. **"Install X as explained at URL"** — LLM ignores the URL, generates an install command from its weights. Actual instructions may differ.
2. **"Install X as explained on their website"** — LLM knows the URL from training, generates from memory, never visits. Training data goes stale; install methods change.
3. **"What does this do: `curl URL | sh`"** — LLM explains `curl` flags from memory instead of fetching and analyzing the script.
4. **"Is this safe? `curl URL | sh`"** — generic "pipe-to-sh is risky" answer instead of a grounded read of the actual script.

### The Grounding Rule

A behavioral rule in the system prompt: **if you can read the real thing, read it instead of guessing.** The LLM probe-fetches URLs whose live content would improve the response, including the implicit case where the user names a known site without pasting a URL.

This is a prompt-level behavior, not a new mechanism. The existing probe loop `curl`s the URL and feeds content back as a conversation turn. The only supporting infrastructure is four extraction tools in `PROBED_TOOLS` and the `🌐` indicator.

### When to Fetch vs Not

The LLM judges from request shape; the rule plus few-shot examples teach the boundary.

| Request | Fetch? | Why |
|---------|--------|-----|
| `install ollama per https://ollama.com` | Yes | Explicit URL for instructions |
| `install ollama as explained on their site` | Yes | Implicit URL from LLM knowledge |
| `what does this do: curl URL \| sh` | Yes | Question is about the script |
| `is this safe? curl URL \| sh` | Yes | Safety needs the actual content |
| `summarize https://example.com/article` | Yes | Question is about URL content |
| `open https://github.com` | No | URL is an argument, not content |
| `what does curl do` | No | About the command, not a URL |
| `ping example.com` | No | URL is a target |

### HTML Extraction

Pages return HTML. The LLM parses HTML natively; the concern is size (marketing pages: 50–200KB). V1: the LLM picks an extraction pipeline based on detected tools.

| Tool | Platform | Pipeline |
|------|----------|----------|
| `textutil` | macOS built-in | `curl -sL URL \| textutil -stdin -format html -convert txt -stdout` |
| `lynx` | Linux/macOS | `curl -sL URL \| lynx -stdin -dump` |
| `w3m` | Linux/macOS | `curl -sL URL \| w3m -dump -T text/html` |
| *(none)* | any | `curl -sL URL` (raw HTML, LLM parses natively) |

`maxProbeOutputChars` truncation keeps huge pages from blowing up context.

**Future: `HTMLRewriter`.** Bun ships `HTMLRewriter` as a built-in global. An enhancement could auto-strip `<script>`, `<style>`, `<svg>`, `<noscript>` from HTML-shaped step output for clean text on any platform without external tools. Deferred — LLM-picks-tool is sufficient for v1.

### Script Safety Analysis

For `curl URL | sh` requests, the LLM fetch-steps the top-level script, reads it, and returns a free-form `reply` grounded in the content. **Flag but not chase** secondary downloads: nested `curl`/`wget` calls are noted ("this script downloads a binary from X") but Wrap doesn't recursively fetch. The user sees what the top level does and decides.

No structured safety template — the LLM answers in its natural voice covering what the script does, what it installs/modifies, and concerns.

### Step Indicator

URL-fetching steps display `🌐` instead of `🔍`. Detection heuristic in `fetchesUrl()`: step content starts with `curl`/`wget` and contains `http(s)://`. Ambiguous cases fall back to `🔍`. Explanation text after the emoji is the LLM's free-form `explanation` field.

**Fetch only, never execute.** URL steps download content — they never pipe a fetched script through a shell. The existing "non-final steps must be `risk_level: low`" check enforces this; the grounding rule reinforces it for the script-analysis case ("read the script as a non-final step, *analyze* it as a reply").

### Dynamic Sites

JS-rendered sites won't return useful content via `curl`. Known limitation shared by all non-browser HTTP clients. Most docs, install pages, and scripts are server-rendered and work fine.
