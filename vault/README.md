---
name: README
description: Vault entry — Wrap, invariants, glossary, module map, index. Read at session start.
Source: src/
Last-synced: c54a1a5
---

# Wrap

Wrap is a command-line tool that translates plain English into shell commands and executes them. `w find all typescript files modified today` → `find . -name '*.ts' -mtime 0`, then runs it. Wrap is opinionated, has personality, stays a good Unix citizen (chrome never pollutes stdout), remembers what it learns about the user's environment, and disappears entirely when a real command runs so `vim`, `top`, and `ssh` work unmodified.

This vault is the living reference for Wrap. It describes **what** Wrap does and **why** decisions were made. It does not describe **how** — how is in the code. When a note and the code disagree, code wins; fix the note, then finish the task. `Source:` frontmatter points at the code each note describes; `Last-synced` carries the short commit sha at which it was last reconciled.

## Vault structure

- **`README.md`** (this file) — orientation, invariants, glossary, module map, index.
- **Concept notes at root** (`wizard.md`, `llm.md`, …) — one per concept, lazy-loaded by topic.
- **`showcase.md`** — examples of Wrap working well.
- **`impl-specs/`** — planning docs for in-flight features. Deleted after implementation.
- **`ideas/`** — future ideas, todos, wishlist.
- **`mockups/`** — shell mockups and throwaway visuals.

**Before writing or restructuring any note, read [[vault-maintenance]].**

---

## Invariants

Always true. If a concept note contradicts one of these, the note is wrong.

1. **stdout is for useful output only.** All Wrap chrome (UI, notifications, etc) goes to stderr or `/dev/tty`. If wrap responds with `answer` that is the payload and can go in stdout.
2. **No stdin contamination.** Drain stdin before the dialog goes interactive. Buffered keystrokes must never auto-confirm a command. See [[session]].
3. **User-facing errors are plain language.** No stack traces, no internal names, no jargon. One prefix per category (e.g. `Config error:`).
4. **TDD.** Write failing test first. See `.claude/skills/testing.md`.

---

## Glossary

Canonical vocabulary. Use consistently; do not invent synonyms.

**Execution**
- **Invocation** — one complete Wrap run: parse → config → memory → query → log.
- **Query** — the LLM interaction loop within an invocation.
- **Round** — one LLM interaction → parsed response → optional execution. Probes, commands, error-fix attempts, and answers are each one round. A round may contain multiple `Attempt`s.
- **Round retry** — re-attempt within a round when the response could not be parsed. Not a new round.
- **Attempt** — one physical LLM call inside a round. Up to four per round (initial → json-retry → scratchpad-retry → scratchpad's json-retry). Each Attempt records its own `parsed`/`error`/`raw_response`/`llm_ms`, plus request and wire bodies when `logTraces` is on.
- **Session** — runtime loop owning app state, dialog lifecycle, notification routing. See [[session]].
- **Mode** — how Wrap is invoked (default, yolo, force-cmd, force-answer, confirm-all). Only `default` is implemented.
- **Subcommand** — CLI sub-action accessed via flag (`--log`, `--help`, `--version`).
- **Modifier flag** — flag stripped pre-dispatch that tweaks a query without branching (`--verbose`, `--model`, `--provider`, `--no-animation`).

**Discovery & memory**
- **Discovery** — ongoing process of learning the environment.
- **Probe** — a command run for discovery, not for the user. Init probe = first-run; tool probe = before every query.
- **Tool watchlist** — persistent list of tool names `which`-checked every run. Grown by LLM `watchlist_additions`.
- **Memory** — collection of scoped facts.
- **Scope** — the directory a fact belongs to.
- **Fact** — one learned item in memory.

**I/O**
- **Chrome** — Wrap's own UI (spinners, confirmations, errors, memory messages). Stderr or `/dev/tty`, never stdout.
- **Output** — useful result on stdout (command output or answer text).
- **User prompt** — the natural-language text after `w`. Distinct from system prompt.
- **Piped input** — stdin when Wrap is in a pipe.
- **Auto-execute** — running a low-risk command without confirmation.
- **Notification bus** — typed pub/sub for chrome events (`src/core/notify.ts`).

**TUI**
- **Dialog** — Ink TUI in alt-screen on stderr. Confirmation, edit, follow-up, processing.
- **Dialog state** — `confirming` / `editing` / `composing` / `processing`.
- **Action bar** — navigable row of actions at dialog bottom.
- **Risk badge** — risk-level pill in the top-right of the border.
- **Text input** — inline editable field (`src/tui/text-input.tsx`).
- **Border status** — animated indicator in the dialog border.
- **Notification router** — single source of truth for "is a dialog up?". Routes notifications to stderr, buffer, or dialog.
- **Wizard section** — top-level unit of the setup wizard. Self-contained React component with its own `<Dialog>` shell and typed result.
- **Wizard screen** — sub-view within a section.

**Response & flow**
- **Response type** — `command` (terminal or intermediate, depending on `final`) or `reply` (text).
- **Follow-up** — in-dialog refinement within one invocation. See [[follow-up]].
- **Continuation** — resuming a previous thread in a new invocation (planned).

**Safety**
- **Risk level** — low / medium / high. LLM-reported; may be escalated by the local rule engine.
- **Effective risk** — `max(llm_risk, rule_risk)`. The value the execution gate uses.
- **Execution gate** — low/medium/high branching point in the session reducer.
- **Trust fence** — recency-bias instruction between untrusted context and the user request.

**Logging & eval**
- **Log** — raw invocation records in JSONL at `~/.wrap/logs/wrap.jsonl`.
- **LogEntry** — record of one invocation.
- **Log traces** — opt-in detailed capture of full prompt and wire-level bodies per Attempt. Off by default. See [[logging]].
- **Example** — curated input/output pair for eval. Not "sample" or "training data".
- **Eval** — offline scoring against examples.
- **Optimization** — using eval results to improve the prompt (DSPy).
- **Few-shot example** — example conversation embedded in the prompt.

**Paths**
- **Pretty path** — display path with `~` as home.
- **Resolved path** — absolute canonical path.
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
  fs/                              ~/.wrap/ filesystem helpers
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
- [[architecture]] — invocation flow, core/session split, cross-cutting decisions
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

### Config & CLI
- [[config]] — sources, precedence, SETTINGS registry, file schema
- [[subcommands]] — subcommands and modifier flags
- [[forget]] — `w --forget` wipes persisted user data

### Observability
- [[logging]] — JSONL logs

### Planned
- [[interactive-mode]] — free-text prompt area when `w` has no args

### Canon
- [[showcase]] — examples of Wrap working well

### Common tasks
- Changing dialog behavior → [[tui]] + [[session]]
- Adding a provider → [[llm]]
- Changing what the LLM sees → [[llm]] + [[discovery]]
- Changing when a command is blocked → [[safety]]
- Changing what gets logged → [[logging]]
- Adding a setting or changing precedence → [[config]]
- Adding a subcommand → [[subcommands]]
- Multi-step flows → [[multi-step]]
- Top-level orchestration, flow order → [[architecture]]
- Editing personality / voice → [[answer-voice]]
- First-run / wizard changes → [[wizard]] + [[config]]
