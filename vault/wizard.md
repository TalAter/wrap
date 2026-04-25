---
name: wizard
description: Interactive TUI that writes a valid config on first run
Source: src/wizard/, src/tui/config-wizard-dialog.tsx, src/tui/wizard-chrome.tsx, src/tui/nerd-icons-section.tsx
Last-synced: 0a22f2a
---

# Wizard

Runs when `w` is invoked with no config on a TTY. Walks the user through nerd-icon preference, provider selection, and defaults, then writes `config.jsonc` plus a copy of the bundled schema. CI and pipe invocations skip the wizard entirely.

Composed of independent **sections** running sequentially. Each section is a self-contained component inside its own dialog shell with a typed result. Sections are unaware of each other; the orchestrator threads results forward by writing to [[config]]'s store between sections so later sections read settings (like nerd-icons) through normal config reads. Sections are individually mountable by design.

Ink and the wizard module are lazy-loaded so their weight stays off the hot path when config exists. Cancellation exits 0; the next invocation re-triggers the wizard.

## Providers section

The largest section. A pure reducer drives a tagged screen union; unit-tested without Ink.

Linear flow, no back navigation: select providers → fetch models → per-provider loop (API key → model pick, or CLI disclaimer) → pick default if more than one. The provider registry (see [[llm]]) is the source of truth and its key order drives display order.

Models come from `models.dev`, cached on disk with a 24h TTL. Filter keeps text-in/text-out chat models that report tool-call support and aren't deprecated; results sort newest-first with a recommended-model promotion. Offline first-run with no cache exits with a clean error.

## Nerd-icons section

Binary detection screen run before providers so later sections know whether to render Nerd Font glyphs. Result is written to config immediately so subsequent sections pick it up through normal reads.

## Writing

A single writer validates every entry, then emits `config.jsonc` and a fresh copy of the bundled schema. CLI providers write an empty entry — the registry flags them as model-optional.

## Decisions

- **No back navigation.** Keeps the state machine simple; misclicks re-run.
- **No API-key validation.** The wizard never calls a provider — invalid keys fail at first real use with a clearer error.
- **`tool_call: true` as filter proxy.** models.dev under-reports `structured_output`; tool-call support reliably identifies modern chat models.
- **CLI providers skip model selection.** Their valid IDs change between versions; letting the CLI pick beats freezing a stale list.
- **Sections are individually mountable.** Self-contained shells let the wizard grow new sections without coupling.
