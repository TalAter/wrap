# Wrap — Natural Language Shell Tool

## Specification v1.0

> **Status:** In progress
> **Date:** 2026-03-18
> **Name:** Wrap (working name — needs conflict check against existing packages/tools)

---

## 1. Overview

### What is Wrap?

Wrap is a command-line tool that translates plain English into shell commands and executes them. You type what you want in natural language, and Wrap figures out the command, shows it to you (or just runs it), and gets out of your way.

```
$ w find all files in my home dir named zsh something
→ find ~ -type f -iname '*zsh*'
```

### Why?

Every developer has the same experience: you know exactly _what_ you want to do, but you can't remember the exact flags, the right `find` syntax, or how to chain `grep` and `awk` together. You've been using the shell for years — maybe decades — but you're not a wizard who has every command memorized. So you leave the terminal, open a browser, ask an LLM, copy the answer back in. That context switch is the problem.

Wrap eliminates the context switch. It puts an LLM directly in the command line, so you never have to leave. It's not faster than typing the command directly if you already know it — but it's much faster than looking it up.

### Who is it for?

- **Experienced-but-not-wizard shell users.** People who use the terminal daily but don't have every command memorized. They know what `find` does but can't remember the flags for case-insensitive name matching. They can pipe things together but have to look up the `awk` syntax every time.
- **Newcomers to the shell.** People who heard that Claude Code is amazing and opened a terminal for the first time. Wrap gives them a natural language interface while they learn.
- **Anyone who's tired of leaving the terminal to look things up.**

### Philosophy

- **Stay in the flow.** The whole point is that you never leave the terminal. Everything — from input to confirmation to output — happens right where you are.
- **Be opinionated with character.** Wrap is not a generic tool. It has personality, a visual identity, and opinions about how things should work. It's fun to use.
- **Be a good Unix citizen.** Wrap's UI never pollutes stdout. Commands can be piped in and out. It plays well with the rest of the shell ecosystem.
- **Learn and adapt.** Wrap gets smarter over time. It remembers your shell, your OS, your preferences. It probes your environment on-demand to give better answers.
- **Be transparent.** When Wrap learns something, it tells you. When it's about to run a dangerous command, it shows you first. When it retries after an error, it shows you what happened.
- **Start simple, stay minimal.** Ship the smallest useful thing first. Resist adding features that aren't needed yet.

### Core Value Prop

Faster than switching to a browser or separate LLM to look up a command. Stays in the terminal.

---

## Glossary

Canonical terms used throughout specs, code, and discussion. Use these consistently.

### Core execution

| Term | Definition |
|------|-----------|
| **Invocation** | One complete Wrap run: parse → config → memory → query → log |
| **Query** | The LLM interaction loop within an invocation (rounds, round retries) |
| **Round** | One LLM call → parsed response → optional execution. Probes, commands, error-fix attempts, answers are each one round. |
| **Round retry** | Re-attempt within a round when the response couldn't be parsed. Not a new round. |

### Discovery & memory

| Term | Definition |
|------|-----------|
| **Discovery** | The ongoing process of learning about the environment (init probes, tool probes, LLM probes, memory updates) |
| **Probe** | An individual command run for discovery (init probe = first-run, tool probe = before every query, LLM probe = mid-query triggered by LLM) |
| **Tool watchlist** | Persistent list of tool names to check via `which` on every run, grown by LLM responses via `watchlist_additions`. Stored in `tool-watchlist.json`, separate from default `PROBED_TOOLS`. |
| **Memory** | A collection of scoped facts learned about the user or their machine. Memory → Scopes → Facts. |
| **Scope** | The directory a fact belongs to in the file system |
| **Fact** | An individual learned item in memory |

### Response & behavior

| Term | Definition |
|------|-----------|
| **Mode** | How you invoke Wrap (default, yolo, force-cmd, force-answer, confirm-all) |
| **Response type** | What the LLM responds with: command, probe, or answer |
| **Follow-up** | TUI action: invoked when the user chooses not to invoke a command and refine it via text input |
| **Continuation** | Resuming a previous conversation thread in a new invocation |
| **Subcommand** | CLI sub-action accessed via flag (--log, --help, --version) |

### Input

| Term | Definition |
|------|-----------|
| **User prompt** | The natural language text after `w`. Distinct from system prompt. |
| **Piped input** | Data from stdin when Wrap is used in a pipe |

### Output

| Term | Definition |
|------|-----------|
| **Chrome** | Wrap's own UI elements (stderr/tty): spinners, confirmations, errors, memory update messages |
| **Output** | Useful result on stdout: command output or answer text |
| **Auto-execute** | Running a low-risk command without confirmation |

### Logging & eval pipeline

| Term | Definition |
|------|-----------|
| **Log** | Raw invocation record in JSONL |
| **LogEntry** | Record of a single invocation (or thread) in the log |
| **Example** | Curated input-output pair for eval (not "sample", "seed", "training data") |
| **Eval** | Dev-only offline scoring of LLM performance against examples |
| **Optimization** | Using eval results to improve the prompt (via DSPy or similar) |
| **Few-shot example** | Example conversation embedded in the prompt |
| **Feedback signal** | Implicit quality indicator extracted from logs (exit code, retries, etc.) |

### Paths & safety

| Term | Definition |
|------|-----------|
| **Pretty path** | Display path with ~ as the home directory |
| **Resolved path** | Absolute canonical path used internally |
| **Safety classification** | The two-layer risk system (LLM risk level + local rule engine) |
| **Risk level** | low/medium/high rating from the LLM |

---

## 2. Language & Architecture

### 2.1 Core Binary: TypeScript

- Written in TypeScript, compiled to a single executable via Bun (`bun build --compile`)
- Handles: CLI parsing, TUI rendering, HTTP to LLM APIs, JSON/JSONC parsing, thread storage, memory system, config management
- Rich ecosystem for all needs: TUI libraries, HTTP clients, JSON schema validation, testing frameworks

### 2.2 Testing Philosophy: TDD

- **Test-driven development as a guiding philosophy.** Write failing tests first, then code. Full coverage is the goal.
- **LLM mock:** The LLM integration layer is behind an interface so tests can swap in a mock that returns deterministic structured JSON responses. This allows testing the entire pipeline — input parsing, context assembly, JSON response handling, safety classification, command execution, memory updates, thread storage — without hitting a real LLM.
- **Memory testing:** Memory tests use real filesystem I/O against isolated temp directories (each test gets its own `WRAP_HOME`). No in-memory mock — test the real thing.
- Tests should cover: mode detection, safety rule engine, JSON parsing/round retry logic, probe loop behavior, memory read/write, thread TTL expiry, TUI rendering (snapshot tests), config validation, piped stdin detection, and error-handling/auto-fix flow.

### 2.3 Dev-Only Tooling: Python Sidecar

- Lives in the repo (e.g., `scripts/eval/` or `eval/`)
- Used for DSPy optimization and eval
- **Never shipped to end users** — not part of the distributed binary
- Accessed via repo scripts (e.g., `make eval`, `python scripts/eval.py`), not via `wrap` subcommands
- Open to alternatives to DSPy

---

## 3. Invocation Modes

Wrap supports multiple modes via symlinks (or aliases — exact mechanism TBD):

| Invocation (exact command TBD) | Behavior                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `wrap <text>` / `w <text>`     | **Default mode.** Smart auto-execute: safe commands run automatically, dangerous commands show confirmation TUI. |
| `wy <text>`                    | **Yolo mode.** No confirmation, ever. Execute immediately.                                                       |
| `w! <text>`                    | **Force command mode.** LLM must return a shell command, not a text answer.                                      |
| `w? <text>`                    | **Force answer mode.** LLM returns a text explanation, not a command.                                            |
| A third variant (TBD)          | **Always confirm.** Every command requires explicit approval.                                                    |

### 3.1 Alias/Symlink Setup

- On first run, Wrap scans for available single-letter commands
- Suggests the best available shortcut (priority: `w` > `wr` > `c` > others)
- Implemented via symlinks (preferred) — Wrap detects invocation name to determine behavior
- Exact symlink vs. shell alias mechanism to be decided during implementation

### 3.2 Mode Auto-Detection

When the user doesn't use an explicit mode flag (`w!`, `w?`):

- The LLM auto-detects whether the input is a command request or a question
- If auto-detection is wrong, user can correct via:
  - Thread continuation: `w no, run that as a command`
  - Re-invoke with explicit flag: `w! <same query>`

---

## 4. Piping Into Wrap (Core Feature)

> See `specs/piped-input.md` for full architecture: detection, buffering, truncation, `pipe_stdin` re-piping, prompt assembly, and interaction with unimplemented features.

Wrap supports receiving piped input as context:

```bash
cat error.log | w what does this error mean
ls -la | w which is the largest file
git diff | w summarize these changes
```

When stdin is a pipe, Wrap reads the full piped content into memory and includes it as LLM context. The LLM can respond with either a command or a text answer depending on the query. When the LLM returns `pipe_stdin: true`, Wrap re-pipes the full buffered content to the spawned command's stdin — enabling commands like `wc -l` or `grep` to process the original data.

For large inputs exceeding `maxPipedTokens` (configurable, default 50k tokens / ~200KB), Wrap truncates what it sends to the LLM but keeps the full buffer for re-piping. No hard ceiling — context windows grow and users with local models may want large inputs.

**Piping from Wrap** works naturally via shell plumbing:

```bash
w find zsh files | grep rc
```

The shell handles `| grep rc` — Wrap only sees `find zsh files`.

---

## 5. Execution & Safety

### 5.1 Smart Safety Classification (Layered)

> **See `specs/safety.md`** for full architecture: local rule engine patterns, adversarial eval, prompt injection resistance, and prompt ordering.

Two layers, either can escalate to confirmation. LLM risk assessment provides the initial signal; a local rule engine (deterministic pattern matching) acts as an independent safety net. The rule engine can only escalate — never lower — the LLM's risk level.

**Behavior by mode:**

- **Default (`w`):** Auto-execute low-risk, confirm medium/high-risk
- **Yolo (`wy`):** Execute everything without confirmation
- **Always-confirm variant:** Confirm everything regardless of risk

### 5.2 Confirmation TUI

When confirmation is needed, show a TUI panel (rendered on /dev/tty or stderr — not stdout):

- Syntax-highlighted command
- Risk level indicator
- Brief explanation of what the command does
- Keybindings vary by risk level (see below)
- The edit option drops into an editable text field for tweaking the command

**Tiered confirmation by risk level:**

| Risk | Keybindings | Rationale |
|------|-------------|-----------|
| **Medium** | `Enter` = run, `e` = edit, `d` = describe, `f` = follow-up, `c` = copy, `Esc` = cancel | Low friction — a single keypress to confirm |
| **High** | `y` + `Enter` = run, `e` = edit, `d` = describe, `f` = follow-up, `c` = copy, `Esc` = cancel | Requires deliberate opt-in |

`q` is an alias for `Esc` (quit convention from vim/less/man).

**High-risk Enter behavior:** Pressing `Enter` alone on a high-risk command does not cancel or run — it highlights the `y + Enter` hint to teach the interaction. The user must type `y` then `Enter` to confirm. This prevents both accidental execution (if Enter ran it) and confusion (if Enter cancelled it).

**`[D]escribe`:** Sends the generated command back to the LLM for a detailed explanation — what each flag does, what side effects to expect, what the output will look like. Displayed inline in the TUI panel. The user can then proceed with the other keybindings. **Does not consume a round** — it's a user-initiated side-channel request, not part of the command-generation loop.

**`[F]ollow-up`:** Opens a text input where the user can type a natural language refinement (e.g., "but only .ts files" or "use rsync instead"). The refinement is sent to the LLM as a thread continuation, and the TUI updates with the new generated command. The user can follow up multiple times before executing or cancelling. **Resets the round counter** — it's effectively a new query with fresh intent, so it gets a fresh round budget. This is only available in the confirmation TUI (medium/high risk commands) — for low-risk commands that auto-execute, the user can continue via `wyada` in a new invocation.

**Input buffer flush:** Before rendering the confirmation prompt, flush/discard any buffered terminal input. This prevents a stray `Enter` (pressed while waiting for the LLM response) from accidentally confirming a dangerous command. The prompt only accepts input after it is fully displayed.

### 5.3 Interactive Commands

Commands that need a TTY (`vim`, `top`, `ssh`, `sudo`):

- Full TTY handoff — Wrap detects interactivity and execs the command directly
- Wrap disappears until the command exits

### 5.4 Long-Running Commands

- Stream stdout/stderr to the terminal in real-time
- Standard Unix passthrough behavior
- No spinner or extra UI during execution

### 5.5 Pipelines

When the task requires multiple piped commands:

- Generate a single composed pipeline (e.g., `find . -name '*.log' | xargs grep ERROR | sort | uniq -c`)
- Do NOT step through commands sequentially with confirmation between steps

### 5.6 Shell History Injection

After Wrap executes a command, it appends the generated command to the shell's history with the original Wrap invocation as an inline comment:

```
w list all files in here        ← recorded by the shell naturally
ls -la # w list all files in here   ← injected by Wrap
```

This gives the user two things when pressing arrow-up:
1. **The generated command** — immediately re-runnable without hitting the LLM. The comment preserves the original intent for readability.
2. **The Wrap invocation** — editable and re-runnable to tweak the natural language request.

Implementation: append to `$HISTFILE` (or use `fc` / `history -s` depending on shell). The inline comment is inert — the shell ignores everything after `#`.

---

## 6. Error Handling & Auto-Fix

### 6.0 When Auto-Fix Applies

Not every non-zero exit code means Wrap should retry. A command can run correctly and still return an error — `curl` hitting a 404, `ls` on a nonexistent path, `grep` finding no matches. These are the command working as intended; the error is the answer.

Auto-fix triggers only on **infrastructure-level failures** — problems with the command itself, not with what the command found:

| Error type | Example | Auto-fix? |
|---|---|---|
| Command not found | `zsh: command not found: pngquant` | **Yes** — try alternative tool (see §6.2) |
| Syntax error | `bash: syntax error near unexpected token` | **Yes** — LLM generated bad syntax |
| Wrong flags | `grep: invalid option -- 'Z'` | **Yes** — LLM used flags that don't exist on this platform |
| Permission denied on binary | `permission denied: /usr/local/bin/foo` | **Maybe** — LLM can suggest `sudo` or alternative |
| Application-level error | `curl: (22) 404 Not Found` | **No** — command worked, server returned 404 |
| No results | `grep` returns exit code 1 (no matches) | **No** — command worked, nothing matched |
| Runtime failure | `node: Cannot find module './foo'` | **No** — the command ran, the program has a bug |

When auto-fix does NOT apply, Wrap simply shows the command's output (stdout + stderr) and exits. The user can continue via `wyada` if they want to try a different approach.

### 6.1 Auto-Fix Flow

When auto-fix applies:

1. Send the error back to the LLM
2. The LLM determines if the error is **fixable** (wrong flags, typo, unavailable tool) or **informational** (permission denied that's inherent)
3. If fixable: LLM generates a corrected command → show for approval (or auto-execute per mode)
4. If informational: output a short LLM-generated explanation alongside the native error

### 6.2 Command Not Found — Memory & Retry

When a command fails with "command not found," the error is sent back to the LLM for both retry and potential memory update. The LLM — not client-side rules — decides what to remember:

- **Well-known tool not installed** (e.g., `command not found: pngquant`, `command not found: brew`): The LLM recognizes this as a system-level fact. It returns a `memory_update` ("pngquant is not installed") and tries an alternative command (e.g., `sips` instead of `pngquant`).
- **Likely a local/project script** (e.g., `command not found: run-tests`): The LLM recognizes this isn't a system tool. No memory update. It may suggest `./run-tests` (CWD-relative) or ask the user to check the path.

Why the LLM decides: a client-side heuristic can't reliably distinguish `brew` (system tool, worth remembering) from `run-tests` (project script, not worth remembering). The LLM has the world knowledge to make this call.

Note: `command not found: foo` (without `./`) means `foo` is not in `$PATH` anywhere. `./foo` failing means the file doesn't exist in the current directory — a different situation entirely, and not a system-level fact.

### 6.3 Retry Loop

- Error-fix rounds and probe rounds share a **unified counter** (see ARCHITECTURE.md — Loop Rules). One budget for all rounds, configurable via `maxRounds`.
- **Default:** 5 rounds total (probes + error-fix attempts), show each attempt (command + error)
- After max rounds exhausted, show final error and stop
- **Rounds only tick for autonomous LLM calls** — probes and auto-fix retries that happen without user intervention. User-initiated actions (Describe, Follow-up) don't consume rounds or reset the budget. See ARCHITECTURE.md — Loop Rules for details.

---

## 7. Discovery

> **See `specs/discovery.md`** for full architecture: init probes, runtime tool probes, tool watchlist, CWD context, and LLM probes.

Wrap learns about its environment through four mechanisms: init probes on first run (baseline OS/shell knowledge), a runtime tool probe on every startup (~5ms `which` call), CWD files on every request (immediate project awareness), and LLM probes during the query loop (on-demand discovery). LLM probes count toward the unified round budget (`maxRounds`); discovered facts flow into scoped memory so the same question is never probed twice. LLM probes also fetch URL content when the user's request mentions a URL whose live page would ground the response — see `specs/discovery.md` § Web Reading.

The **tool watchlist** (`tool-watchlist.json`) extends the runtime tool probe over time. LLM responses can nominate tools via `watchlist_additions`; these are checked via `which` on every future invocation. See `specs/discovery.md` for details.

---

## 8. LLM Integration

### 8.1 Structured JSON Output

The LLM must return structured JSON. All response types use a single `content` field:

```json
{
  "type": "command" | "probe" | "answer",
  "content": "the shell command (command/probe) or text response (answer)",
  "risk_level": "low" | "medium" | "high",
  "explanation": "brief description of what this does",
  "memory_updates": [
    {"fact": "Default shell is zsh, config at ~/.zshrc", "scope": "/"},
    {"fact": "Uses pnpm", "scope": "/Users/tal/myproject"}
  ],
  "memory_updates_message": "Noted: you use zsh; this project uses pnpm",
  "watchlist_additions": ["sips", "convert", "magick", "pngquant"]
}
```

### 8.2 Structured Output & Parsing

- The LLM response schema (section 8.1) is defined as a **Zod schema** — single source of truth for TypeScript types, runtime validation, and JSON Schema generation.
- Uses the **Vercel AI SDK** (`ai` v6 + `@ai-sdk/anthropic` + `@ai-sdk/openai`) with native structured output support.
- If JSON parsing fails: round retry — retry once with a stricter prompt and the broken JSON ("respond ONLY with valid JSON").
- No client-side JSON repair — rely on provider structured output support + one round retry.
- See `specs/llm-sdk.md` for full provider architecture and implementation details.

### 8.3 Prompt Strategy

- System prompt is a configurable template (not hardcoded)
- Start with a basic functional prompt
- Evolve and optimize via DSPy (or similar) in the eval pipeline

### 8.4 Provider Support & Wire Format

> **Implemented.** See `specs/llm-sdk.md` for full provider architecture: interface design, AI SDK integration, context assembly, config, and round retry.

Provider-agnostic interface supporting API providers (Anthropic, OpenAI, Ollama via `baseURL`) and CLI tool providers (Claude Code). BYOK — bring your own key.

### 8.5 Context Sent to LLM

Each request includes:

- User's natural language input
- Current working directory
- Curated environment variables: `PATH`, `EDITOR`, `SHELL` (never secrets like API keys)
- Facts filtered to the current directory (global facts always included; directory-specific facts only when CWD matches)
- Detected tools from runtime `which` probe (see `specs/discovery.md` — Runtime Tool Probe)
- Thread history (if continuing a thread)
- Piped stdin content (if present — with token count warning presented to user for very large inputs)

**Prompt section order** — the final user message assembles context sections in this order:

1. **Piped input** — `## Piped input` (when present — first section, before memory; see `specs/piped-input.md`. Not yet implemented)
2. **Memory facts** — `## System facts`, then `## Facts about {path}` for matching scopes
3. **Detected tools** — `## Detected tools` (runtime `which` output)
4. **CWD** — `- Working directory (cwd): {path}` (+ `## Files in CWD` when listing is implemented)
5. **User's request** — `## User's request`

---

## 9. Thread System

### 9.1 Thread Continuation

Wrap supports continuing previous conversations in single-shot mode:

```bash
$ w find all zsh files
# → runs: find / -name '*.zsh'
$ wyada but only in my home dir
# → context: knows previous command, runs: find ~ -name '*.zsh'
```

By default it will not continue a thread, only if we use the command for continuing a thread (`wyada` in the sample above, but real command still needs TBD).

### 9.2 Thread Storage

- Stored in a `./threads` folder  (or similar)
- Each thread stores: user inputs, generated commands, command stdout/stderr (full output), LLM responses
  - **Note:** stdout/stderr capture may conflict with the logging spec's decision to stream output directly via `inherit` (see `specs/logging.md`, Execution fields). Needs investigation before implementation — teeing can break TTY behavior, colors, and interactive commands.
- **Persistence:** threads persist across terminal sessions
- **TTL:** threads expire after a configurable time period
- **Large output warning:** before sending a thread with large stored output to the LLM, warn the user about token count

### 9.3 Thread Identification

- Mechanism for linking a continuation to its parent thread. Initially it will just be the most recent thread in the current terminal window.

---

## 10. Memory / Learning System

> **Implemented.** See `specs/memory.md` for full architecture: scoped storage, path conventions, data flow, prompt assembly, init flow, and runtime updates.

Wrap learns facts about the user's environment and persists them to disk. Facts are scoped to directories — global facts always sent, project-specific facts only when CWD matches. The LLM returns `memory_updates` in its responses; these are written immediately (even mid-loop) and the user is notified on stderr. First run probes the system eagerly; everything else is discovered on-demand.

---

## 11. Output & UI

### 11.1 Output Channels

**Hard rule: Wrap's chrome (UI, notifications, confirmations) must never pollute stdout.**

Stdout is reserved for **useful output** — the thing the user or a downstream pipe actually wants:

- **Command mode:** stdout belongs to the executed command.
- **Answer mode:** the answer text goes to stdout.

This means answers compose naturally with Unix pipelines:

```bash
# Populate a config value without leaving the terminal
echo "timeout: $(w? what is a good HTTP timeout in seconds, just the number)" >> config.yml

# Pipe an answer into a clipboard
w? summarize the MIT license in one sentence | pbcopy
```

Wrap's own output (TUI panels, notifications, confirmations) goes to a non-stdout channel:

| Channel    | What goes there                                                                 |
|------------|---------------------------------------------------------------------------------|
| **stdout** | Useful output: command's stdout (command mode) or answer text (answer mode)     |
| **stderr** | Wrap chrome: confirmations, risk warnings, memory notifications, probe status, errors |
| **/dev/tty** | Interactive TUI (confirmation panel, edit field)                              |

### 11.2 Answer Rendering — TTY-Aware

Answer output adapts based on whether stdout is a TTY:

| Condition | LLM prompt | Output |
|-----------|-----------|--------|
| **stdout is TTY** | Ask LLM to format answer as markdown | Render as colorful terminal markdown — syntax-highlighted code blocks, bold/italic, lists, etc. |
| **stdout is piped** | Ask LLM for plain text, no markdown syntax | Raw text to stdout, clean for piping into files, `pbcopy`, etc. |

The prompt itself changes — Wrap tells the LLM whether to use markdown or plain text. This is cleaner than stripping markdown client-side, and gives the LLM freedom to structure plain-text answers well without leaking `**` and `` ``` `` into piped output.

**Edge case — user wants markdown in piped output** (e.g., `w? explain X | tee notes.md`): deferred. Users can add "in markdown" to their prompt for now. A future `--md` flag could override the default.

**Blocked on:** TUI library selection (see Open Questions §17.3). The terminal markdown rendering approach depends on which TUI library we adopt. Design this after the TUI library is in place.

**Hard rule still applies:** the rendered answer text goes to stdout. Wrap chrome (if any surrounds the answer) stays on stderr/tty.

### 11.3 Visual Identity & Character

Wrap is opinionated and has personality:

- All Wrap messages use a distinctive color scheme
- Messages prefixed with an emoji (specific emoji TBD — part of the brand)
- Visual styling makes Wrap output instantly distinguishable from command output
- The tool should feel fun and characterful, not sterile

### 11.4 TUI Components

Built for the confirmation flow and future interactive needs:

- **Confirmation panel:** bordered box with syntax-highlighted command, risk indicator, explanation
- **Radio buttons / single-select:** for choosing between LLM-suggested options
- **Checkboxes / multi-select:** for multi-option scenarios
- **Free text input:** for answering clarification questions
- **Editable command field:** inline editing of the generated command before execution

---

## 12. Configuration

### 12.1 Config Loading (Layered)

Config is loaded in priority order (highest wins):

1. **`WRAP_CONFIG` env var** — JSON string, useful for testing, scripting, and one-off overrides.
2. **JSONC config file** — `~/.wrap/config.jsonc` (directory overridable via `WRAP_HOME` env var).
3. **Defaults** — no default provider. If unconfigured, Wrap errors and prompts setup (future: first-run UI).

Merge behavior: **shallow merge** — `WRAP_CONFIG` overrides top-level keys from the file config. Nested objects (e.g., `provider`) are replaced entirely, not deep-merged.

### 12.2 Config Validation

- No runtime schema validation in v1 — invalid config produces clear `Config error:` messages via manual checks.
- Future: may add Zod or similar for runtime validation, TypeScript type derivation, and JSON Schema generation from a single source of truth.

### 12.3 Format: JSONC with JSON Schema

- Config file at `~/.wrap/config.jsonc`
- JSONC (JSON with comments) for human editability
- JSON Schema (`src/config/config.schema.json`) is the single source of truth, written to `~/.wrap/config.schema.json` during first-run setup
- Config file references it via `"$schema": "./config.schema.json"` for editor support (VS Code, etc.):
  - Auto-completion of keys
  - Validation of values
  - Descriptions/documentation for each setting
  - Type checking
- Schema uses `oneOf` for discriminated unions (e.g., different provider types have different required fields)

### 12.4 Configurable Settings

Currently only `provider` is implemented. Future settings shown below for reference:

```jsonc
{
  // LLM provider configuration (IMPLEMENTED — see specs/llm-sdk.md)
  "provider": { "type": "anthropic" },

  // Safety (NOT YET IMPLEMENTED — see specs/safety.md)
  "defaultMode": "smart", // "smart" | "yolo" | "confirm-all"

  // LLM round budget (IMPLEMENTED — maxRounds. showRetryAttempts not yet implemented)
  "maxRounds": 5,
  "maxProbeOutputChars": 200000, // ~200KB cap on probe output fed to LLM
  "showRetryAttempts": true,

  // Threads (NOT YET IMPLEMENTED)
  "threadTTL": "24h",

  // Display
  // ...TBD
}
```

---

## 13. Eval System (Dev-Only)

Dev-only prompt optimization pipeline. DSPy/MIPRO discovers the best instruction text and few-shot examples by evaluating candidates through a Bun eval bridge that uses the same prompt assembly and LLM execution as runtime — guaranteeing parity between what's optimized and what ships.

- Lives in `eval/` — Docker-based, not distributed with the binary
- Examples in `eval/examples/seed.jsonl`; logging data (see `specs/logging.md`) feeds future examples
- Output: `src/prompt.optimized.json` (instruction, demos, schema text, prompt hash)
- Full architecture: `eval/specs/eval.md`

---

## 14. First-Run Experience

1. User runs `wrap` (or `wrap <query>`) for the first time
2. `ensureConfig()` detects no config → runs config wizard (see ARCHITECTURE.md)
3. **Provider selection:** TUI presents available options:
   - **CLI tool providers:** Any detected installed tools (Claude Code, Codex, AMP). If selected, show the terms-of-service disclaimer (see 8.4) and require acknowledgment.
   - **API providers:** OpenAI, Anthropic, Ollama (local), OpenRouter, etc. — user enters API key and selects a model.
   - User picks a default provider + model. Can change later via config.
   - Prompt user to enter their LLM API key if needed
4. **Alias setup:** scan for available single-letter commands, suggest best option
   - Priority list: `w` > `c` > others (tbd)
   - Show available options, let user choose
   - Create shell aliases with glob protection — natural language prompts should never be expanded by the shell:
     - **zsh:** `alias w='noglob wrap'` — `noglob` prevents glob expansion (`*`, `?`, `[…]`) on the command's arguments
     - **bash:** `w() { (set -f; command wrap "$@"); }` — `set -f` disables globbing; subshell prevents leaking
     - **fish:** `function w; command wrap $argv; end` — fish passes non-matching globs literally, but matching globs still expand; no `noglob` equivalent exists
   - Mode variants (`wy`, `w!`, `w?`) get the same glob protection
   - Note: glob protection does not prevent `$()` or backtick expansion — only the keybinding integration (see §16) fully solves that
5. `ensureMemory()` finds no existing memory → probes the system, sends output to LLM to parse into facts, saves to disk
6. **Done** — if user provided a query, it continues to execute. Otherwise, ready for next invocation.

---

## 15. Subcommands

> See `specs/subcommands.md` for full architecture and current commands.

Subcommands use `--` flags to avoid colliding with natural language input. Currently implemented: `--help`, `--version`, `--log`. Future: `--config`, `--memory`.

---

## 16. Scope — Explicitly Deferred

The following are acknowledged good ideas but **not in v1**:

| Feature                         | Notes                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| **Command recipes**             | User-defined natural language → command shortcuts. e.g., "deploy this" or "package wrap".    |
| **Interactive mode**            | Free-text prompt area when `w` is run with no args. See `specs/interactive-mode.md`.        |
| **REPL / conversational mode**  | Interactive session where user refines commands iteratively (separate from interactive mode).|
| **Cost tracking**               | Per-command and cumulative LLM cost estimates.                                               |
| **Secret redaction**            | Auto-detect and mask API keys/passwords before sending to LLM.                               |
| **Shell completions**           | Tab-completion for `wrap` subcommands and recent queries.                                    |
| **History browser**             | `wrap history` with search and re-run capability.                                            |
| **Vector database for memory**  | Selective retrieval of relevant memories instead of full dump.                               |
| **Memory TTL**                  | LLM-assigned expiry on memories.                                                             |
| **Distribution strategy**       | Brew formula, apt packages, etc. (though `brew install wrap` is desired).                    |

---

## 17. Open Questions

1. **Name conflicts:** Does `wrap` conflict with existing packages on Homebrew, apt, npm, etc.? Need to research.
2. **TUI library:** Which TypeScript/Node TUI library? (Ink? Blessed? Custom ANSI? Needs research.) Blocking: confirmation TUI, interactive mode, answer rendering.
3. **Symlink vs. alias vs. multi-call binary:** Exact mechanism for `w`, `wy`, `w!`, `w?` variants. Aliases are preferred over symlinks because they enable glob protection via `noglob` (zsh) / `set -f` (bash). Symlinks can't provide this.
4. **Thread linking:** How does a continuation find its parent thread? Most recent? Terminal session detection?
5. **`w!` and `w?` as symlink names:** `!` and `?` are shell special characters. These may need to be flags (`w --cmd`, `w --ask`) rather than symlink names. Needs investigation.
6. **Always-confirm alias:** What should the third mode (always confirm) be named?

---

## Appendix A: Example Flows

In the examples above, lines beginning with `#` are a note to you about what's happening. They are not displayed to the user

### A.1 Basic Command (Default Mode) - low risk

```
$ w find all typescript files modified today
# no output from wrap. will run `find . -name '*.ts' -mtime 0` and its output will go to stdout
./src/index.ts
./src/utils/parser.ts
```

### A.2 Basic Command (Default Mode) - high risk
```
$ w delete everything here
🔮 rm -rf *
  ⚠ High risk · This will delete everything in the current directory and any of its subdirectories
  [y+Enter] Run  [e] Edit  [d] Describe  [f] Follow-up  [c] Copy  [Esc] Cancel
```

### A.3 Yolo Mode

```
$ wy delete all .DS_Store files recursively
🔮 Deleting .DS_Store files in current directory and its subdirectories
# executes immediately, no confirmation: find . -name '.DS_Store' -delete

$ wy delete all .DS_Store files everywhere
🔮 Deleting .DS_Store files anywhere on your computer
# executes immediately, no confirmation: find / -name '.DS_Store' -delete
```

### A.4 Piped Input (Answer Mode)

```
$ cat error.log | w what is causing this crash
🔮 The crash is caused by a null pointer dereference on line 42 of parser.rs.
   The `unwrap()` call on an Option<&str> fails when the input JSON is missing
   the "name" field. Fix: use `unwrap_or_default()` or proper error handling.
```

### A.5 Thread Continuation

```
$ w find all log files larger than 100mb
🔮 find / -name '*.log' -size +100M
  [runs, shows results]

$ wyada but only in /var/log
🔮 find /var/log -name '*.log' -size +100M
  [context from previous thread]
```

### A.6 Probe + Memory

```
$ w add an alias for ll to my shell config
🧠 Noted: you use zsh, config at ~/.zshrc
🔮 echo "alias ll='ls -la'" >> ~/.zshrc
  Medium risk · Appends to your shell config file
  [Enter] Run  [e] Edit  [d] Describe  [f] Follow-up  [c] Copy  [Esc] Cancel
```

### A.7 Auto-Fix on Error (Command Not Found)

```
$ w compress all pngs in this folder
# tries running pngquant --quality=65-80 *.png
zsh: command not found: pngquant
🧠 Noted: pngquant is not installed
🔧 Trying alternative...
# runs `for f in *.png; do sips -s format png -s formatOptions 80 "$f"; done`
```

### A.8 Non-Retryable Error (Application-Level)

```
$ w curl the api endpoint at example.com/users
# runs curl https://example.com/users
< HTTP/1.1 404 Not Found
# Wrap exits. The command worked; the server returned 404. No auto-fix.
# User can follow up: wyada try the /api/users path instead
```

