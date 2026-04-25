---
name: README
description: Vault entry — Wrap, invariants, glossary, module map, index. Read at session start.
Source: src/
Last-synced: 0a22f2a
---

# Wrap

Wrap is a CLI that translates plain English into shell commands and runs them. `w find all typescript files modified today` → `find . -name '*.ts' -mtime 0`, then runs it. Opinionated, has personality, good Unix citizen (chrome never pollutes stdout), remembers what it learns, disappears entirely when a real command runs so `vim`, `top`, `ssh` work unmodified.

This vault is the living reference: **what** Wrap does and **why** decisions were made — never **how** (that's in the code). Code wins on conflict; fix the note. `Source:` points at the code each note describes; `Last-synced` is the sha at which it was last reconciled.

**Before writing or restructuring any note, read [[vault-maintenance]].**

---

## Invariants

Always true. If a concept note contradicts one, the note is wrong.

1. **stdout is for useful output only.** Chrome (UI, notifications) goes to stderr or `/dev/tty`. Answer-mode payload may go to stdout.
2. **No stdin contamination.** Drain stdin before the dialog goes interactive. Buffered keystrokes must never auto-confirm. See [[session]].
3. **User-facing errors are plain language.** No stack traces, no internal names. One prefix per category (e.g. `Config error:`).
4. **TDD.** Failing test first. See `.claude/skills/testing.md`.

---

## Glossary

Canonical vocabulary. Use consistently; do not invent synonyms.

**Execution**
- **Invocation** — one Wrap run.
- **Query** — the LLM interaction loop within an invocation.
- **Round** — one LLM interaction → parsed response → optional execution. Probes, commands, error-fixes, answers are each one round.
- **Attempt** — one physical LLM call inside a round. A round may retry on parse failure.
- **Session** — runtime loop owning app state, dialog lifecycle, notification routing. See [[session]].
- **Mode** — how Wrap is invoked (default, yolo, force-cmd, force-answer, confirm-all). Only `default` is implemented.
- **Subcommand** — CLI sub-action via flag (`--log`, `--help`).
- **Modifier flag** — flag stripped pre-dispatch that tweaks a query without branching (`--verbose`, `--model`).

**Discovery & memory**
- **Discovery** — ongoing process of learning the environment.
- **Probe** — a command run for discovery, not for the user.
- **Tool watchlist** — persistent list of tool names `which`-checked every run.
- **Memory** — scoped facts learned about the environment. Scope = directory the fact belongs to.

**I/O**
- **Chrome** — Wrap's own UI (spinners, confirmations, errors). Stderr or `/dev/tty`, never stdout.
- **Output** — useful result on stdout (command output or answer text).
- **User prompt** — natural-language text after `w`. Distinct from system prompt.
- **Piped input** — stdin when Wrap is in a pipe.
- **Auto-execute** — running a low-risk command without confirmation.

**TUI**
- **Dialog** — Ink TUI in alt-screen on stderr. Confirmation, edit, follow-up, processing.
- **Action bar** — navigable row of actions at dialog bottom.
- **Notification router** — single source of truth for "is a dialog up?". Routes notifications to stderr, buffer, or dialog.

**Response & flow**
- **Response type** — `command` (terminal or intermediate, depending on `final`) or `reply` (text).
- **Follow-up** — in-dialog refinement within one invocation. See [[follow-up]].
- **Continuation** — resuming a previous thread in a new invocation (planned).

**Safety**
- **Risk level** — low / medium / high. LLM-reported; may be escalated by the local rule engine.
- **Effective risk** — `max(llm_risk, rule_risk)`. The value the execution gate uses.
- **Trust fence** — recency-bias instruction between untrusted context and the user request.

**Logging & eval**
- **Log** — JSONL invocation records at `~/.wrap/logs/wrap.jsonl`.
- **Log traces** — opt-in detailed capture of full prompt and wire bodies. Off by default. See [[logging]].
- **Example** — curated input/output pair for eval. Not "sample" or "training data".
- **Eval** — offline scoring against examples.
- **Optimization** — using eval results to improve the prompt (DSPy).

**Paths**
- **`$WRAP_HOME`** — runtime data dir. Default `~/.wrap/`.

---

## Module map

```
src/
  index.ts, main.ts                bin entry + top-level orchestration — [[architecture]]
  command-response.schema.ts       Zod schema for LLM responses
  prompt.constants.json            fixed instructions + section headers
  prompt.optimized.json            DSPy-generated: instruction + demos + schema text

  core/                            pure loop — [[session]], [[safety]], [[theme]], [[piped-input]]
  session/                         stateful loop + dialog lifecycle — [[session]]
  tui/                             Ink presentation — [[tui]], [[theme]]
  llm/                             providers, prompt scaffold — [[llm]]
  config/                          sources, precedence, store — [[config]]
  wizard/                          first-run wizard — [[wizard]]
  discovery/                       probes, watchlist, cwd files — [[discovery]]
  memory/                          scoped facts — [[memory]]
  logging/                         JSONL writer — [[logging]]
  subcommands/                     CLI subcommands — [[subcommands]]
```

Runtime data at `~/.wrap/` (overridable via `$WRAP_HOME`): `config.jsonc`, `memory.json`, `tool-watchlist.json`, `logs/wrap.jsonl`.

---

## Index

### Runtime
- [[architecture]] — invocation flow, core/session split
- [[session]] — dialog lifecycle, state machine, notification routing
- [[multi-step]] — non-final commands and multi-round flows
- [[follow-up]] — in-dialog refinement
- [[safety]] — risk classification and execution gates
- [[piped-input]] — stdin materialization + file-based prompt framing

### LLM
- [[llm]] — providers, prompt scaffold, structured output
- [[memory]] — scoped facts
- [[discovery]] — init probes, tool watchlist, cwd files
- [[scratchpad]] — scratchpad field
- [[answer-voice]] — answer-mode voice

### UI
- [[tui]] — Ink dialog, text-input, border
- [[theme]] — colors, dark/light, color depth
- [[wizard]] — first-run config wizard
- [[interactive-mode]] — free-text compose when `w` has no args on a TTY

### Config & CLI
- [[config]] — sources, precedence, SETTINGS registry
- [[subcommands]] — subcommands and modifier flags
- [[forget]] — `w --forget` wipes persisted user data

### Observability & distribution
- [[logging]] — JSONL logs
- [[release]] — cutting a release; brew tap design

### Canon
- [[showcase]] — examples of Wrap working well
