# Wrap — Natural Language Shell Tool

> **Status:** In progress · v1.0 · 2026-03-18
>
> Wrap is the product vision document: what the tool is, who it's for, the canonical vocabulary, and the high-level UX contract. Implementation details live in the sub-specs listed below.

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

- **Experienced-but-not-wizard shell users.** People who use the terminal daily but don't have every command memorized.
- **Newcomers to the shell.** People who heard that Claude Code is amazing and opened a terminal for the first time.
- **Anyone who's tired of leaving the terminal to look things up.**

### Philosophy

- **Stay in the flow.** The whole point is that you never leave the terminal.
- **Be opinionated with character.** Wrap has personality, visual identity, and opinions about how things should work. It's fun to use.
- **Be a good Unix citizen.** Wrap's UI never pollutes stdout. Commands can be piped in and out.
- **Learn and adapt.** Wrap gets smarter over time — remembers shell, OS, preferences; probes the environment on-demand.
- **Be transparent.** When Wrap learns something, it tells you. Dangerous commands are shown first. Retries show what happened.
- **Start simple, stay minimal.** Ship the smallest useful thing first.

### Core value prop

Faster than switching to a browser or separate LLM to look up a command. Stays in the terminal.

---

## 2. Map of sub-specs

Read the sub-spec for the area you care about. Each owns its architecture, reasoning, and gotchas; this document does not repeat them.

| Area | Spec |
|---|---|
| Runtime architecture, modules, data flow | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| Query/session loop, reducer, pumpLoop, notification router | [`session.md`](./session.md) |
| LLM providers, config, SDK integration, prompt scaffold | [`llm.md`](./llm.md) |
| Multi-step command flows (planned) | [`multi-step.md`](./multi-step.md) |
| TUI / dialog / Ink layout / text-input | [`tui.md`](./tui.md) |
| Follow-up refinement flow | [`follow-up.md`](./follow-up.md) |
| Risk classification, rule engine, modes, injection defenses | [`safety.md`](./safety.md) |
| Environment discovery, probes, tool watchlist, CWD files | [`discovery.md`](./discovery.md) |
| Scoped memory facts | [`memory.md`](./memory.md) |
| Piped stdin | [`piped-input.md`](./piped-input.md) |
| Subcommands (`--log`, `--help`, `--version`) | [`subcommands.md`](./subcommands.md) |
| Verbose mode (stderr narrative) | [`verbose.md`](./verbose.md) |
| Structured JSONL logging | [`logging.md`](./logging.md) |
| Answer-mode voice | [`answer-voice.md`](./answer-voice.md) |
| Scratchpad (planned) | [`scratchpad.md`](./scratchpad.md) |
| Interactive mode (planned) | [`interactive-mode.md`](./interactive-mode.md) |
| Open TODOs across the project | [`todo.md`](./todo.md) |

---

## 3. Glossary

Canonical terms used throughout specs, code, and discussion. Use these consistently.

### Core execution

| Term | Definition |
|------|-----------|
| **Invocation** | One complete Wrap run: parse → config → memory → query → log |
| **Query** | The LLM interaction loop within an invocation (rounds, round retries) |
| **Round** | One LLM call → parsed response → optional execution. Probes, commands, error-fix attempts, answers are each one round. |
| **Round retry** | Re-attempt within a round when the response couldn't be parsed. Not a new round. |
| **Session** | The runtime loop owning app state, dialog lifecycle, and notification routing. See `session.md`. |

### Discovery & memory

| Term | Definition |
|------|-----------|
| **Discovery** | The ongoing process of learning about the environment (init probes, tool probes, LLM probes, memory updates) |
| **Probe** | An individual command run for discovery (init probe = first-run, tool probe = before every query, LLM probe = mid-query triggered by LLM) |
| **Tool watchlist** | Persistent list of tool names to check via `which` on every run, grown by LLM responses via `watchlist_additions` |
| **Memory** | A collection of scoped facts learned about the user or their machine |
| **Scope** | The directory a fact belongs to in the file system |
| **Fact** | An individual learned item in memory |

### Response & behavior

| Term | Definition |
|------|-----------|
| **Mode** | How you invoke Wrap (default, yolo, force-cmd, force-answer, confirm-all). Only `default` is currently implemented — see `safety.md`. |
| **Response type** | What the LLM responds with: command, probe, or answer |
| **Continuation** | Resuming a previous conversation thread in a new invocation (planned) |
| **Follow-up** | In-dialog refinement within one invocation. Distinct from continuation. See `follow-up.md`. |
| **Subcommand** | CLI sub-action accessed via flag (`--log`, `--help`, `--version`) |
| **Modifier flag** | Flag stripped pre-dispatch that tweaks a query without branching into a subcommand (`--verbose`, `--model`, `--provider`) |

### Input & output

| Term | Definition |
|------|-----------|
| **User prompt** | The natural language text after `w`. Distinct from system prompt. |
| **Piped input** | Data from stdin when Wrap is used in a pipe |
| **Chrome** | Wrap's own UI elements (stderr/tty): spinners, confirmations, errors, memory update messages. Never stdout. |
| **Output** | Useful result on stdout: command output or answer text |
| **Auto-execute** | Running a low-risk command without confirmation |
| **Notification bus** | Typed pub/sub for Wrap chrome events (`src/core/notify.ts`). Verbose, logging, and the dialog all consume it. |

### TUI

| Term | Definition |
|------|-----------|
| **Dialog** | Interactive Ink TUI rendered in alt-screen on stderr. Confirmation, edit, follow-up, processing. See `tui.md`. |
| **Dialog state** | One of: `confirming`, `editing`, `composing`, `processing`. Each transition flushes pending stdin. |
| **Action bar** | Navigable row of actions at the bottom of the dialog |
| **Risk badge** | Risk level pill embedded in the top-right of the dialog's top border |
| **Text input** | Inline editable text field with cursor management (`src/tui/text-input.tsx`) |
| **Border status** | Animated indicator embedded in the bottom of the dialog's border (spinner + chrome during `processing`) |
| **Notification router** | Single source of truth for "is a dialog up?"; routes notifications to stderr, buffer, or dialog. See `session.md` / `tui.md`. |

### Safety

| Term | Definition |
|------|-----------|
| **Risk level** | low / medium / high rating. Reported by the LLM; may be escalated by the local rule engine. |
| **Effective risk** | `max(llm_risk, rule_risk)` — the value the execution gate actually uses |
| **Execution gate** | The low/medium/high branching point in the session reducer |
| **Trust fence** | The recency-bias instruction between untrusted context and the user request |

### Logging & eval

| Term | Definition |
|------|-----------|
| **Log** | Raw invocation record in JSONL at `~/.wrap/logs/wrap.jsonl` |
| **LogEntry** | Record of a single invocation in the log |
| **Example** | Curated input-output pair for eval (not "sample", "seed", "training data") |
| **Eval** | Dev-only offline scoring of LLM performance against examples |
| **Optimization** | Using eval results to improve the prompt (via DSPy) |
| **Few-shot example** | Example conversation embedded in the prompt |

### Paths

| Term | Definition |
|------|-----------|
| **Pretty path** | Display path with `~` as home |
| **Resolved path** | Absolute canonical path used internally |
| **`$WRAP_HOME`** | Runtime data dir, default `~/.wrap/` |

---

## 4. Invocation modes

Wrap is invoked via single-letter aliases. Only default mode is currently implemented.

| Invocation | Behavior |
|---|---|
| `w <text>` | **Default.** Low-risk auto-executes; medium/high shows the dialog. |
| `wy <text>` | **Yolo** (planned). No confirmation ever. |
| `w! <text>` | **Force command** (planned). LLM must return a command. |
| `w? <text>` | **Force answer** (planned). LLM returns a text answer. |
| *TBD* | **Always-confirm** (planned). Every command requires approval. |

See `safety.md` for the risk/mode matrix and `discovery.md` for how aliases are installed on first run.

---

## 5. Hard rules (non-negotiable invariants)

These apply everywhere and cross sub-spec boundaries. If they ever conflict with a sub-spec, the sub-spec is wrong.

1. **Stdout is for useful output only.** Wrap chrome (UI, notifications, confirmations, errors) must never write to stdout. All chrome goes to stderr or `/dev/tty`.
2. **No stdin contamination.** Stdin must be drained before the dialog becomes interactive, to prevent buffered keystrokes from auto-confirming a dangerous command.
3. **Effective risk is monotone.** The rule engine may only escalate the LLM's risk level, never lower it.
4. **Memory writes are immediate.** A fact discovered mid-query is persisted before the invocation ends, even if the invocation later fails.
5. **Logging failures are swallowed.** A broken log file must never crash a Wrap invocation.
6. **Wrap disappears during exec.** Once a command is confirmed, Wrap unmounts the dialog, releases raw mode, and hands the tty to the child with `inherit` stdio. No spinner, no status line, no chrome overlay while the child runs. Interactive commands (`vim`, `top`, `ssh`, `sudo`) work because Wrap is not in the way; long-running commands stream stdout/stderr directly to the terminal. Wrap reappears only after the child exits.

---

## 6. First-run experience

1. User runs `wrap` (or `wrap <query>`) for the first time.
2. `ensureConfig()` detects no config → runs config wizard (future — see `tui.md`).
3. **Provider selection:** CLI tool providers (Claude Code, etc.) if detected; API providers (Anthropic, OpenAI, Ollama, OpenRouter) with key entry. See `llm.md`.
4. **Alias setup** scans for available single-letter commands, suggests the best one, and installs with glob protection so natural-language prompts never expand:
   - **zsh:** `alias w='noglob wrap'`
   - **bash:** `w() { (set -f; command wrap "$@"); }`
   - **fish:** `function w; command wrap $argv; end` (fish has no `noglob`; non-matching globs pass through literally, matching globs still expand)
   - Glob protection does not prevent `$()` or backticks — only keybinding integration would fully solve that.
5. `ensureMemory()` probes the system, parses into facts, saves to disk. See `memory.md` and `discovery.md`.
6. If a query was provided, execution continues.

---

## 7. Error handling (design notes)

Not every non-zero exit code means Wrap should retry. A command can run correctly and still return an error — `curl` hitting a 404, `ls` on a nonexistent path, `grep` finding no matches. These are the command working as intended.

**Auto-fix (planned, not implemented)** triggers only on infrastructure-level failures:

| Error type | Example | Auto-fix? |
|---|---|---|
| Command not found | `zsh: command not found: pngquant` | Yes — try alternative |
| Syntax error | `bash: syntax error` | Yes |
| Wrong flags | `grep: invalid option` | Yes |
| Application-level error | `curl: 404 Not Found` | No |
| No results | `grep` exit 1 | No |
| Runtime failure | `node: Cannot find module` | No |

**Command-not-found memory updates:** the LLM — not client-side rules — decides whether to remember. A missing `brew` is a system-level fact; a missing `run-tests` is probably a project script and not worth remembering.

Error-fix rounds share the `maxRounds` budget with probes. See `session.md` for the round-budget machinery.

---

## 8. Thread continuation (planned)

A command like `wyada but only in my home dir` would continue the most recent thread in the current terminal. Open questions: thread linking (most-recent? terminal session id?), storage shape, TTL, large-output warnings before re-sending to the LLM. Distinct from in-dialog **follow-up** — follow-up lives within a single invocation; continuation spans invocations.

**Storage gotcha:** teeing the child's output into a thread file conflicts with hard-rule #6 (Wrap disappears during exec). Teeing breaks TTY detection, strips colors, and mangles interactive commands like `vim` and `top`. Any implementation must either re-read output from the log (if logging grows an exec-capture mode), or accept that thread storage is stdin/LLM-turn only and commands do not contribute their real output.

---

## 9. Visual identity

- Distinctive color scheme on all Wrap chrome.
- Emoji prefixes for different event types (exact set TBD).
- Synthwave gradient dialog borders that shift hue by risk level. See `tui.md`.
- The tool should feel fun and characterful, not sterile.

---

## 10. Scope — explicitly deferred

Acknowledged good ideas, **not in v1**:

| Feature | Notes |
|---|---|
| **Command recipes** | User-defined natural-language → command shortcuts |
| **Interactive mode** | Free-text prompt area when `w` is run with no args. See `interactive-mode.md`. |
| **REPL / conversational mode** | Iterative session (separate from interactive mode) |
| **Cost tracking** | Per-command and cumulative LLM cost |
| **Secret redaction** | Auto-mask API keys/passwords before sending to LLM |
| **Shell completions** | Tab-completion for subcommands and recent queries |
| **History browser** | `wrap history` with search and re-run |
| **Vector database for memory** | Selective retrieval instead of full dump |
| **Memory TTL** | LLM-assigned expiry on facts |
| **Distribution strategy** | Brew formula, apt packages, etc. |

---

## 11. Open questions

1. **Name conflicts:** Does `wrap` conflict with existing packages on Homebrew, apt, npm?
2. **Symlink vs. alias vs. multi-call binary** for `w` / `wy` / `w!` / `w?`. Aliases currently preferred (they enable `noglob`).
3. **`!` and `?` as alias names:** shell-special, may need to become flags (`w --cmd`, `w --ask`).
4. **Thread linking:** most-recent thread? Terminal-session id? Explicit ref?
5. **Always-confirm alias:** what should the third mode be called?
6. **Shell history injection:** writing the generated command back to `$HISTFILE` with the original prompt as an inline comment. Value is clear; implementation (`fc` vs `history -s` vs direct write) is not.

---

## Appendix A: Example flows

Illustrative only. `#` lines are annotations, not user output.

### A.1 Low-risk command
```
$ w find all typescript files modified today
# no chrome, auto-executes: find . -name '*.ts' -mtime 0
./src/index.ts
./src/utils/parser.ts
```

### A.2 High-risk command
```
$ w delete everything here
╭─────────────────────────── ⚠ high risk ──╮
│  rm -rf *                                  │
│  Deletes everything in the current dir.    │
│  [y] Run  [e] Edit  [f] Follow-up  [Esc]   │
╰────────────────────────────────────────────╯
```

### A.3 Yolo mode (planned)
```
$ wy delete all .DS_Store files recursively
# executes immediately, no confirmation: find . -name '.DS_Store' -delete
```

### A.4 Piped input (answer mode)
```
$ cat error.log | w what is causing this crash
The crash is a null pointer on line 42 of parser.rs. `unwrap()` on an
Option<&str> fails when the input JSON is missing the "name" field.
```

### A.5 Probe + memory update
```
$ w add an alias for ll to my shell config
🧠 Noted: you use zsh, config at ~/.zshrc
╭── ⚠ medium risk ──╮
│ echo "alias ll='ls -la'" >> ~/.zshrc │
│ [Enter] Run  [e] Edit  [Esc]         │
╰──────────────────────────────────────╯
```

### A.6 Command-not-found auto-fix (planned)
```
$ w compress all pngs in this folder
# tries: pngquant --quality=65-80 *.png
zsh: command not found: pngquant
🧠 Noted: pngquant is not installed
🔧 Trying alternative...
# runs: for f in *.png; do sips -s format png -s formatOptions 80 "$f"; done
```
