# Wrap — Natural Language Shell Tool

## Specification v1.0

> **Status:** Pre-implementation spec
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

## 2. Language & Architecture

### 2.1 Core Binary: TypeScript

- Written in TypeScript, compiled to a single executable via Bun or Deno
- Handles: CLI parsing, TUI rendering, HTTP to LLM APIs, JSON/JSONC parsing, thread storage, memory system, config management
- Rich ecosystem for all needs: TUI libraries, HTTP clients, JSON schema validation, testing frameworks

### 2.2 Testing Philosophy: TDD

- **Test-driven development as a guiding philosophy.** Write failing tests first, then code. Full coverage is the goal.
- **LLM mock:** The LLM integration layer is behind an interface so tests can swap in a mock that returns deterministic structured JSON responses. This allows testing the entire pipeline — input parsing, context assembly, JSON response handling, safety classification, command execution, memory updates, thread storage — without hitting a real LLM.
- **Memory mock:** The memory/learning system is behind an interface so tests can use an in-memory store instead of the filesystem. This allows testing memory read/write, deduplication, and (future) TTL expiry without touching disk or worrying about test isolation.
- Tests should cover: invocation mode detection, safety rule engine, JSON parsing/retry logic, probe loop behavior, memory read/write, thread TTL expiry, TUI rendering (snapshot tests), config validation, piped stdin detection, and error-handling/auto-fix flow.

### 2.3 Dev-Only Tooling: Python Sidecar

- Lives in the repo (e.g., `scripts/eval/` or `eval/`)
- Used for DSPy prompt optimization and eval analysis
- **Never shipped to end users** — not part of the distributed binary
- Accessed via repo scripts (e.g., `make eval`, `python scripts/eval.py`), not via `wrap` subcommands
- Open to alternatives to DSPy

---

## 3. Invocation Modes

Wrap supports multiple invocation variants via symlinks (or aliases — exact mechanism TBD):

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

Wrap supports receiving piped stdin as context:

```bash
cat error.log | w what does this error mean
ls -la | w which is the largest file
git diff | w summarize these changes
```

When stdin is a pipe, Wrap includes the piped data as LLM context. The LLM can respond with either a command or a text answer depending on the query.

**Piping from Wrap** works naturally via shell plumbing:

```bash
w find zsh files | grep rc
```

The shell handles `| grep rc` — Wrap only sees `find zsh files`.

---

## 5. Execution & Safety

### 5.1 Smart Safety Classification (Layered)

Two layers, either can escalate to confirmation:

**Layer 1 — LLM Risk Assessment:**

- The LLM returns a risk level alongside the generated command (part of structured JSON response)
- Risk levels inform whether to auto-execute or confirm

**Layer 2 — Local Rule Engine:**

- Hard-coded patterns: `rm`, `rm -rf`, `sudo`, `dd`, `chmod`, `mkfs`, `> /dev/`, `shutdown`, `reboot`, etc.
- Fast, deterministic, no extra tokens
- Acts as a safety net even if the LLM misclassifies risk

**Behavior by mode:**

- **Default (`w`):** Auto-execute low-risk, confirm medium/high-risk
- **Yolo (`wy`):** Execute everything without confirmation
- **Always-confirm variant:** Confirm everything regardless of risk

### 5.2 Confirmation TUI

When confirmation is needed, show a TUI panel (rendered on /dev/tty or stderr — not stdout):

- Syntax-highlighted command
- Risk level indicator
- Brief explanation of what the command does
- Keybindings: `Enter` = run, `e` = edit command, `q` = cancel
- The edit option drops into an editable text field for tweaking the command

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

---

## 6. Error Handling & Auto-Fix

When a generated command fails (non-zero exit code or stderr):

1. Automatically send the error back to the LLM
2. The LLM determines if the error is **fixable** (wrong flags, typo, missing path) or **informational** (port already in use, permission denied that's inherent)
3. If fixable: LLM generates a corrected command → show for approval (or auto-execute per mode)
4. If informational: output a short LLM-generated explanation alongside the native error

### 6.1 Retry Loop

- **Default:** max 2 auto-fix retries, show each attempt (command + error)
- **Configurable:** users can change max retries and verbosity in config
- After max retries exhausted, show final error and stop

---

## 7. Agent Loop (Probe Commands)

The LLM can return probe/discovery commands before the final command:

```
User: "add this alias to my shell config"
LLM: {type: "probe", command: "echo $SHELL"}  → result: /bin/zsh
LLM: {type: "probe", command: "ls ~/.zshrc ~/.zprofile 2>/dev/null"}  → result: /Users/tal/.zshrc
LLM: {type: "command", command: "echo 'alias ll=ls -la' >> ~/.zshrc"}
```

### 7.1 Probe Behavior

- Probes execute silently (not shown in stdout)
- Subtle indicator on /dev/tty or stderr during probes: e.g., `🔍 Checking shell type...`
- Probe results are fed back to the LLM as context
- **Default max probes:** 3 (configurable)
- Probe results that reveal reusable facts trigger the memory system

---

## 8. LLM Integration

### 8.1 Structured JSON Output

The LLM must return structured JSON:

```json
{
  "type": "command" | "probe" | "answer",
  "command": "the shell command (if type is command/probe)",
  "answer": "text response (if type is answer)",
  "risk_level": "low" | "medium" | "high",
  "explanation": "brief description of what this does",
  "memory_updates": [
    {"key": "shell", "value": "zsh"},
    {"key": "shell config location", "value": "/Users/tal/.zshrc"}
  ],
  "memory_updates_message": "Noted: you use zsh, config at ~/.zshrc"
}
```

### 8.2 Structured Output & Parsing

- The LLM response schema (section 8.1) is defined as a **Zod schema** — single source of truth for TypeScript types, runtime validation, and JSON Schema generation.
- Use the **OpenAI SDK** (`openai` package) with `response_format` for structured output.
- Since all providers speak OpenAI format, one SDK handles everything — runtime provider switching is just changing `baseURL`.
- If JSON parsing fails: retry once with a stricter prompt and the broken JSON ("respond ONLY with valid JSON").
- No client-side JSON repair — rely on provider structured output support + one retry.

### 8.3 Prompt Strategy

- System prompt is a configurable template (not hardcoded)
- Start with a basic functional prompt
- Evolve and optimize via DSPy (or similar) in the dev eval pipeline

### 8.4 Provider Support & Wire Format

**Single integration target: OpenAI-compatible chat completions API.**

The LLM API landscape has converged on the OpenAI `/v1/chat/completions` format as a de facto standard. Anthropic, Ollama, Groq, Together, Mistral, and most other providers expose OpenAI-compatible endpoints. Wrap implements one HTTP client that speaks this format and gets broad provider support for free.

A provider is just a configuration:
```jsonc
{
  "baseUrl": "https://api.openai.com/v1",  // or any compatible endpoint
  "apiKey": "sk-...",
  "model": "gpt-4o-mini"
}
```

- **Local models (Ollama):** Speak the same format at `http://localhost:11434/v1/chat/completions` — works with no extra code.
- **Open-source routers (LiteLLM, OpenRouter):** Can sit in front of any provider and normalize the interface. Good for users who want flexibility without Wrap needing per-provider logic.
- **One SDK for all API providers:** The `openai` npm package talks to any OpenAI-compatible endpoint. Runtime provider switching is just changing `baseURL` in the client config — no per-provider packages needed.
- **Structured output:** OpenAI SDK's `response_format` with JSON Schema generated from the Zod schema (see 8.2). Falls back to prompt-based enforcement for providers that don't support it.
- API key configuration: BYOK (bring your own key)

#### CLI Tool Providers

In addition to API-based providers, Wrap supports using locally-installed CLI LLM tools as backends:

- **Claude Code** (`claude`), **Codex** (`codex`), **AMP** (`amp`), and similar tools that accept a prompt via CLI and return output to stdout.
- Wrap invokes them as subprocesses, passing the system prompt + user query, and parses their stdout as the structured JSON response.
- This lets users leverage tools they already have installed and authenticated — Wrap is just calling them, not using their credentials externally.
- **Disclaimer:** On first selecting a CLI tool provider, Wrap shows a notice: _"Wrap invokes [tool name] as a subprocess using your existing installation and authentication. Review [tool name]'s terms of service to confirm this usage is permitted."_ The user must acknowledge before proceeding.
- CLI providers are configured like:
  ```jsonc
  {
    "type": "cli",
    "command": "claude",
    "args": ["--print", "--output-format", "json"]  // TBD per tool
  }
  ```

### 8.5 Context Sent to LLM

Each request includes:

- User's natural language input
- Current working directory
- Curated environment variables: `PATH`, `EDITOR`, `SHELL` (never secrets like API keys)
- All memory entries (in the future we might only send relevant subset via vector search)
- Thread history (if continuing a thread)
- Piped stdin content (if present — with token count warning presented to user for very large inputs)

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
- **Persistence:** threads persist across terminal sessions
- **TTL:** threads expire after a configurable time period
- **Large output warning:** before sending a thread with large stored output to the LLM, warn the user about token count

### 9.3 Thread Identification

- Mechanism for linking a follow-up command to its parent thread. Initially it will just be the most recent thread in the current terminal window.

---

## 10. Memory / Learning System

### 10.1 Storage

- v1: simple text file(s) in `./memory/` folder (or similar)
- Contents appended to the LLM system prompt on every request
- Future: vector database for selective retrieval of relevant memories

### 10.2 Learning Behavior

- The LLM can return `memory_updates` in its structured response
- **Always notify the user** when something new is learned
- Notifications appear on the non-stdout channel (stderr or /dev/tty)
- Combine multiple learnings to one message. e.g.: `🧠 Noted: you use zsh, config at ~/.zshrc`

### 10.3 Memory TTL (Future)

Some learned facts are ephemeral — e.g., "pngquant is not installed" or "sips is installed" might change after a `brew install`. In the future, the LLM could assign a TTL to memory entries (e.g., "remember this for 24 hours"). This prevents Wrap from repeatedly trying the same failing approach when a transient condition has already been discovered, while still allowing stale facts to expire naturally.

Not in v1 — all memories persist until manually cleared or overwritten.

### 10.4 Probing for Knowledge

- **First run:** minimal silent probe (detect OS, shell type — basics only)
- **Lazy probing:** everything else is discovered on-demand when the LLM determines it needs the information (via the agent loop / probe commands)
- This means Wrap gets smarter over time as you use it

---

## 11. Output & UI

### 11.1 Output Channels

**Hard rule: Wrap UI must never pollute stdout.**

Stdout is reserved exclusively for the executed command's output, enabling clean piping:

```bash
w list docker containers | grep running  # works correctly
```

Wrap's own output (TUI panels, notifications, confirmations) goes to a non-stdout channel. Implementation decides between:

- `/dev/tty` for TUI elements (recommended — invisible to all redirections)
- `stderr` for brief notifications
- Or a combination

Choose for ease of implementation and idiomatic linux/language behavior.

### 11.2 Visual Identity & Character

Wrap is opinionated and has personality:

- All Wrap messages use a distinctive color scheme
- Messages prefixed with an emoji (specific emoji TBD — part of the brand)
- Visual styling makes Wrap output instantly distinguishable from command output
- The tool should feel fun and characterful, not sterile

### 11.3 TUI Components

Built for the confirmation flow and future interactive needs:

- **Confirmation panel:** bordered box with syntax-highlighted command, risk indicator, explanation
- **Radio buttons / single-select:** for choosing between LLM-suggested options
- **Checkboxes / multi-select:** for multi-option scenarios
- **Free text input:** for answering clarification questions
- **Editable command field:** inline editing of the generated command before execution

---

## 12. Configuration

### 12.1 Format: JSONC with JSON Schema

- Config file at `config.jsonc` (or similar)
- JSONC (JSON with comments) for human editability
- Ship a JSON Schema so editors (VS Code, etc.) provide:
  - Auto-completion of keys
  - Validation of values
  - Descriptions/documentation for each setting
  - Type checking

### 12.2 Configurable Settings (non-exhaustive)

```jsonc
{
  // LLM provider configuration
  "provider": "openai", // or "anthropic", "ollama", etc.
  "model": "gpt-4o-mini",
  "apiKey": "sk-...", // or reference env var

  // Safety
  "defaultMode": "smart", // "smart" | "yolo" | "confirm-all"
  "alwaysConfirm": ["docker", "kubectl", "aws", "rm"],
  "neverConfirm": ["ls", "cat", "echo", "pwd"],

  // Retry behavior
  "maxRetries": 2,
  "showRetryAttempts": true,

  // Agent loop
  "maxProbeSteps": 3,

  // Threads
  "threadTTL": "24h",

  // Display
  // ...TBD
}
```

---

## 13. Eval System (Dev-Only)

### 13.1 Purpose

- Evaluate different LLM models and prompts
- Optimize system prompt via DSPy
- Determine cheapest viable model
- Troubleshoot and improve command generation quality

### 13.2 Structured Logging

When evals are enabled (manual opt in only), log to JSONL:

```json
{
  "timestamp": "2026-03-18T14:30:00Z",
  "input": "find all zsh files",
  "context": {"cwd": "/Users/tal", "os": "darwin", "shell": "zsh", "memory": [...]},
  "llm_request": {"provider": "openai", "model": "gpt-4o-mini", "prompt": "..."},
  "llm_response": {"command": "find ~ -name '*.zsh'", "risk_level": "low", ...},
  "executed": true,
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "implicit_feedback": "success_no_retry"
}
```

### 13.3 Feedback Signal

- **Implicit only** (no explicit thumbs-up/down prompt in the tool)
- Correctness inferred from:
  - Exit code (0 = likely correct)
  - Whether the user retried or continued the thread with a correction
  - Whether the auto-fix loop was triggered
- This data feeds into DSPy for prompt optimization

### 13.4 Eval Infrastructure

- Lives in the repo but not distributed
- DSPy or similar
- Ideally runs in a container so as not to polute the dev machine.

---

## 14. First-Run Experience

1. User runs `wrap` (or `wrap <query>`) for the first time
2. **Minimal silent probe:** detect OS, shell type, basic environment. Also detect which CLI LLM tools are installed (`claude`, `codex`, `amp`, etc.).
3. **Provider selection:** TUI presents available options:
   - **CLI tool providers:** Any detected installed tools (Claude Code, Codex, AMP). If selected, show the terms-of-service disclaimer (see 8.4) and require acknowledgment.
   - **API providers:** OpenAI, Anthropic, Ollama (local), OpenRouter, etc. — user enters API key and selects a model.
   - User picks a default provider + model. Can change later via config.
   - Prompt user to enter their LLM API key if needed
4. **Alias setup:** scan for available single-letter commands, suggest best option
   - Priority list: `w` > `c` > others (tbd)
   - Show available options, let user choose
   - Create symlinks (or aliases) for chosen shortcuts including mode variants (`wy`, `w!`, `w?`)
5. **Done** — user can immediately start using the tool

---

## 15. Subcommands

### 15.1 v1 Approach

- Focus entirely on the core `wrap <natural language>` flow
- Subcommands (`wrap config`, `wrap memory`, `wrap thread`, `wrap history`, etc.) will be designed later as needs emerge
- The only "subcommand-like" behavior in v1 is `wrap` with no arguments (triggers first-run setup or shows help)

---

## 16. Scope — Explicitly Deferred

The following are acknowledged good ideas but **not in v1**:

| Feature                         | Notes                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| **Command recipes**             | User-defined natural language → command shortcuts. e.g., "deploy this" or "package wrap".    |
| **REPL / conversational mode**  | Interactive session where user refines commands iteratively.                                 |
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
2. **Runtime choice:** Bun or Deno for compiling to a single executable? Both support it. Evaluate tradeoffs (binary size, startup time, compatibility).
3. **TUI library:** Which TypeScript/Node TUI library? (Ink? Blessed? Custom ANSI? Needs research.)
4. **JSONC parser:** Use an existing JSONC parser (e.g., `jsonc-parser` from VS Code) or strip comments before `JSON.parse`?
5. **Symlink vs. alias vs. multi-call binary:** Exact mechanism for `w`, `wy`, `w!`, `w?` variants.
6. **Thread linking:** How does a follow-up command find its parent thread? Most recent? Terminal session detection?
7. **`w!` and `w?` as symlink names:** `!` and `?` are shell special characters. These may need to be flags (`w --cmd`, `w --ask`) rather than symlink names. Needs investigation.
8. **Always-confirm alias:** What should the third invocation variant (always confirm) be named?

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
  High risk · This will delete everything in the current directory and any of its subdirectories
  [Enter] Run  [e] Edit  [q] Cancel
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
  [Enter] Run  [e] Edit  [q] Cancel
```

### A.7 Auto-Fix on Error

```
$ w compress all pngs in this folder
# tries running pngquant --quality=65-80 *.png
zsh: command not found: pngquant
🔧 Command failed. Trying alternative...
# runs `for f in *.png; do sips -s format png -s formatOptions 80 "$f"; done`
```
