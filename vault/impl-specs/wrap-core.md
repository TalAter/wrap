---
name: wrap-core
description: Guidelines, philosophy, and settled decisions for promoting shared substrate from wrap into wrap-core as sweep needs it.
---

# wrap-core

Reference doc for the shared-substrate package depended on by both wrap and sweep. Consulted whenever sweep reaches for something wrap already has.

**Not a migration project.** No branch, no schedule, no monolithic extraction. wrap-core grows organically as sweep develops — when sweep needs a substrate that wrap has, that's the trigger to promote. Most decisions get made during the work; this doc captures the philosophy and the few decisions already settled.

## Why

Wrap is gaining a sibling: **Sweep**. Different domains, deeply similar substrate — both need TUI primitives, theme, LLM providers, dialog infra, config, chrome, shell.

Wrap's existing modules carry incidental wrap-specific couplings — response schemas baked into prompt scaffolding, named palettes hard-coded in theme, dialog state graphs wired to wrap's flow. The line between *framework* and *application* is real but fuzzy. Promotion unwinds those couplings: each module gets reshaped as pure framework code on the way into core, with wrap-specific concerns lifted to parameters.

**wrap-core ends up cleaner than the original wrap modules.** Most important principle — promotion is not a rename or a move, it is a refactor.

## Approach

Promotions are **demand-pulled by sweep**. When sweep needs something wrap already has: extract from wrap, refactor for purity, wire both consumers in the same commit. Both consumers exercise core from day one of each promotion — the framework shape is clarified by genuine two-consumer pressure, not anticipated reuse.

## Repo layout

Three repos:
- `wrap` at `~/mysite/wrap/`
- `wrap-core` at `~/mysite/wrap-core/`
- `sweep` at `~/mysite/sweep/`

Linkage via `bun link`:
- `bun link` once in `~/mysite/wrap-core/`.
- Each consumer depends on wrap-core via `"wrap-core": "link:wrap-core"` in its `package.json`.

## Boundary

Core holds framework primitives. Each tool keeps its application graph.

**Likely substrate** (promote when sweep's use confirms need; not exhaustive):
- LLM providers + prompt scaffold (schema, voice, tool-specific text passed as params)
- Dialog state-machine infra — reducer, lifecycle, notification routing
- TUI primitives — dialog, action bar, text-input, key bindings
- Theme + ANSI / color depth (theming protocol; tools override via params)
- Config resolution + store (settings registry per-tool)
- Logging writer (per-tool round payload via generic; field names neutral)
- Chrome (spinner, stderr output), shell execution
- Wizard step framework

**Stays per-tool**:
- Response schema + its prompt scaffolding (voice, tool-specific instructions) — passed into core
- Concrete state graph
- Primary response dialog
- Memory, discovery, tool watchlist (wrap-specific)
- Wizard intro/outro
- DSPy + eval

**Refactor for purity is the default.** When a likely-substrate module reaches back into a stays-per-tool concern, lift the dep to a parameter or constructor arg — even if it touches the consumer side. **Stop and surface to the user** only when a stays-per-tool concept would land on core's *public API contract* (not just implementation), or when the coupling forces scope to balloon. Rare.

**Tightly-coupled clusters promote as a unit** (e.g. chrome cluster: `spinner`, `output`, `notify`, `verbose` share state via the notify bus). Run an import-graph closure on the target before starting (`rg "from ['\"]\.\./<module>" src/`) — widen the unit if the closure pulls in unmigrated likely-substrate.

Intra-core couplings (e.g. `tui` imports `ansi`) are normal — not surprises.

## Settled decisions

**Repo & build**
- Separate repo, not monorepo.
- No build step in core. Source TS ships directly as entry. Avoids dual sources of truth.
- TypeScript 5; tooling mirrors wrap (biome, tsconfig strictness, `.bun-version`, `bunfig.toml`). Bun for everything; never npm/pnpm.
- wrap-core ships its own `CLAUDE.md` and `vault/`. Designed for LLM consumption.
- Deps installed per-module on first need. No pre-emptive installs.

**Imports & exports**
- Subpath exports: `import { ... } from "wrap-core/tui"`. No root barrel.
- Module surface = `src/<module>/index.ts`. Only paths listed in `package.json` `exports` are importable; siblings inside `src/<module>/` are private.
- Intra-core imports use relative paths with `.ts` extensions (`../theme/index.ts`). Mirrors wrap's convention.

**Dependencies**
- Peer deps for singleton-required libraries (`react`, `ink`, `@inkjs/ui`). Each consumer also lists them. Two copies of React (or two Ink runtimes) silently break hooks, contexts, and the rendering tree.
- `@types/react` is `devDependency` in wrap-core and each consumer.
- Direct deps for everything else (`ai`, `@ai-sdk/*`, `zod`, `jsonc-parser`). wrap-core's pin is the source of truth; consumers inherit transitively.

## Module shape

- **Factory + generics for stateful or per-tool-configured modules; namespace-of-functions for pure utilities.** Modules with state or per-tool params expose `createFoo<T>(opts): Api<T>` — generics flow through factory, opts type, and returned interface so consumer types reach the call site without casts. The returned `Api` is an interface, not a class; lifecycle (start/stop, dispose) lives in the caller's hands. Tests construct fresh instances; no global state to reset.

- **Generics over interfaces for per-tool values** (response schema, voice, theme overrides, settings registry) — types flow through to the consumer.

- **Domain-neutral field names in core types.** No `memory`, `provider`, `audit`, `risk` etc. Where core needs an extension slot for per-tool data, name it neutrally (`context`, `extras`, `payload`, `tail`) and flow the per-tool shape through a generic. Lifting types alone is not enough — field names leak vocabulary too.

- **Heavy deps are lazy-loaded.** `await import("foo")` inside the conditional that uses them — never top-level imported or re-exported from a module's `index.ts`. Heavy = ≥10 MB parse cost or ≥50 ms cold-start (`ai`, `@ai-sdk/*` barrels, anything with a large transitive graph).

- **Refactor freely. Consumer rewires are in scope.** Promotion is a refactor opportunity. Reshape the surface, lift wrap-specific deps to params, drop dead methods. Every consumer rewire (wrap AND sweep) is part of the same promotion commit, atomic with the new surface — no "I'll rewire consumers next." Forbidden form of reshape: **speculative reduction not driven by both consumers' actual usage.** Don't cut methods because sweep "won't need them" if sweep hasn't proven it. If a method has no consumer in either tool, drop it.

- **TDD. No module promotes without tests.** If wrap has no unit tests for the candidate, write them against the intended pure-framework interface — failing first, passing after the refactor. Tests + their helpers move with the module. Core has its own `tests/`. General helpers (used by 2+ test files) live at `wrap-core/tests/helpers.ts` — single shared file. A helper shared with stays-in-wrap tests is copied (not moved); duplication noted in the commit body.

**Atomic commits across all three repos.** Each commit leaves wrap, wrap-core, and sweep passing `bun run check`. Slice into commits at green-state checkpoints; slicing is your call.

## Vault

Two layers in wrap-core's `vault/`:

- `wrap-core/vault/<concept>.md` — **internals** (LLMs working inside core). Standard concept-note style — see wrap's `vault/vault-maintenance.md`. Write one when the promotion involved a non-obvious refactor (lifted deps, surface reshape, rejected alternative). Pure copy-with-rename gets none.
- `wrap-core/vault/wrap-core-api/<concept>.md` — **usage surface** (LLMs in consumer tools). Compact: frontmatter (`name`, `description`, `package`) → one-paragraph purpose → table of public symbols (Symbol | Shape | Note) → pointer to internals at the bottom.

Each consumer symlinks the api dir: `vault/wrap-core-api → ../node_modules/wrap-core/vault/wrap-core-api`. Symlink committed in each consumer repo (every wrap worktree's `vault/` shares git state, so committing once propagates).

If a wrap concept has shifted into core, wrap can leave a stub note pointing at the canonical doc in wrap-core's vault. Stubs only point *into* core — core never references its consumers.

`wrap-core/vault/README.md` and the first internals/api note land together on whichever promotion first writes any file under `wrap-core/vault/`.

## Cross-package LLM context

Consumer-side LLM sessions stay aware of wrap-core's capabilities through:
- `bun link` symlinks wrap-core into `node_modules/wrap-core/` in each consumer. Source + vault readable at that path during dev.
- wrap-core's `CLAUDE.md` and `vault/README.md` are the entry points; each consumer's `CLAUDE.md` carries a pointer added on its first promotion.
- The `wrap-core-api` symlink in each consumer's vault gives consumer-side LLMs direct access to usage docs as if they were native.
- Public exports carry minimal TSDoc for IDE-hover surface lookup.

### Pointer block for each consumer's `CLAUDE.md` (added once per consumer)

```markdown
## wrap-core dependency

wrap-core is a sibling package providing shared substrate. When working on shared substrate (TUI primitives, theme, providers, dialog infra, config), read `vault/wrap-core-api`
```
