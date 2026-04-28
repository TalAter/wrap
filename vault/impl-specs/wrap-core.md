---
name: wrap-core
description: Long-running migration. Extract shared substrate (wrap-core) so wrap and Sweep can depend on it.
Source: src/, ../wrap-core/
Last-synced: b53c3e0
---

# wrap-core extraction

## Motivation

Wrap (CLI: translates English → shell command, runs it) is gaining a sibling: **Sweep** (CLI: audits piped-curl install scripts before running them, with risk classification and a view-before-run flow). Different domains, deeply similar substrate — both need TUI primitives, theme, LLM providers, wizard, config, dialog infra. Building each twice is duplication; building once and depending on a shared package keeps both coherent.

Cross-promotion ("powered by wrap") is a brand link, not load-bearing on shared code. The reason for sharing is technical: clean abstractions emerge from refactor-and-extract; updates to substrate land once.

Wrap's existing modules carry incidental wrap-specific couplings — response schemas baked into prompt scaffolding, named palettes hard-coded in theme, dialog state graphs wired to wrap's flow. The line between *framework* and *application* is real but fuzzy in current code. The migration unwinds those couplings: each module gets reshaped as pure framework code on the way into core, with wrap-specific concerns lifted to parameters or constructor args. Sweep then plugs into the same primitives with its own concerns.

**Wrap-core ends up cleaner than the original wrap modules.** This is the most important principle — migration is not a rename or a move, it is a refactor.

## Repo layout

`wrap` is at `~/mysite/wrap/`; `wrap-core` is at `~/mysite/wrap-core/`. Linkage is via `bun link`:

- wrap-core has been registered globally (`bun link` was run once in `~/mysite/wrap-core/`).
- wrap depends on wrap-core via `"wrap-core": "link:wrap-core"` in `package.json`. `bun install` resolves it via the global link registry → `node_modules/wrap-core/` becomes a symlink to wrap-core's source.
- Path-independent: works from canonical wrap or any worktree.

**Work locations:**
- **wrap migrations** are done in the worktree at `~/mysite/wrap/.claude/worktrees/wrap-core/` (branch `worktree-wrap-core`).
- **wrap-core migrations** are done directly in `~/mysite/wrap-core/`.

A single agent has shell access to both. Each consumer checkout (worktree or canonical) needs `bun install` once so its `node_modules/wrap-core/` symlink exists; the global registration is shared.

## Boundary

Core holds framework primitives. Each tool keeps its application graph.

Candidates for core:
- LLM providers + prompt scaffold (schema, voice, tool-specific text passed in as params)
- Dialog state-machine infra — reducer, lifecycle, notification routing
- TUI primitives — dialog, action bar, text-input, key bindings
- Theme + ANSI / color depth (theming protocol with sensible defaults; tools override via params)
- Wizard step framework + reusable steps (provider, model, nerd-font check)
- Config resolution + store (settings registry per-tool)
- Logging writer — `entry.ts` currently imports `Memory` and `CommandResponse`; migration requires generifying the entry shape so per-tool memory + schema types flow as generics
- Chrome (spinner, stderr output), shell execution

Stays per-tool, never migrates:
- Response schema + its prompt scaffolding (voice, tool-specific instructions) — passed into core
- Concrete state graph
- Primary response dialog
- Memory, discovery, tool watchlist (wrap-specific)
- Wizard intro/outro
- DSPy + eval

The "stays per-tool" list is the working boundary. Agents may not move a stays-per-tool module unilaterally. Boundary changes — including reclassifying anything from candidates-for-core to stays-per-tool — happen only via the escalation path.

When an agent hits an unexpected coupling — a candidate-for-core module reaching back into a stays-per-tool concern — the default is **refactor for purity**: lift the dep to a parameter or constructor arg. Pause and escalate only when the coupling is *semantic* (the per-tool concept appears in the module's public API contract, not just its implementation) AND lifting it would require changes in many files outside the migrating module. Rare.

Intra-core couplings (e.g. `tui` imports `ansi`) are normal — not surprises.

**Tightly-coupled clusters in wrap's `core/` migrate as a unit.** Examples: chrome cluster (`spinner`, `output`, `notify`, `verbose` share state via the notify bus); state-machine cluster (reducer + lifecycle + notification routing). Before starting, the agent runs an import-graph closure on its target — if the closure pulls in unmigrated wrap-core candidates, either widen the migration to include them or pause.

## Architecture decisions

- **Separate repo, not monorepo.** Each consumer owns its repo and release. Core is a third.
- **`bun link` for dev linkage.** wrap depends via `"wrap-core": "link:wrap-core"`. Bun's global link registry resolves it to wrap-core's source via `node_modules/wrap-core`. Path-independent — works from canonical wrap or any worktree, no `file:` paths to maintain.
- **No build step in core.** Source TS ships directly as entry. Avoids `tsc -d` watcher overhead and dual sources of truth.
- **Subpath exports.** `import { ... } from "wrap-core/tui"`. Each migrated module gets its own subpath. No root barrel.
- **Subpath naming.** Single segment when the module has a single-word natural name (`wrap-core/tui`, `wrap-core/wizard`). Hyphenate only when no single word fits (`state-machine`, `action-bar`).
- **Module surface = `src/<module>/index.ts`.** Only paths listed in `package.json` `exports` are importable. Sibling files inside `src/<module>/` are private.
- **Intra-core imports use relative paths with `.ts` extensions** (mirrors wrap's convention; `tsconfig` enables `allowImportingTsExtensions`). Form: `../theme/index.ts`, not `wrap-core/theme`. Avoids self-referential resolution.
- **TypeScript 5.** Locked. Consumers don't track 6 yet.
- **Tooling mirrors wrap.** Same biome, same tsconfig strictness, same `.bun-version`. Bun for everything; never npm/pnpm. wrap-core's `.bun-version` and `bunfig.toml` are in place; bunfig has the `[test] preload` config wired. The first I/O-touching migration brings `tests/preload.ts` from wrap.
- **Deps installed per-module on first need.** No pre-emptive installs.
- **Tests + their helpers move with the module.** Core has its own `tests/`. A helper used only by moving tests moves with them; a helper shared with stays-in-wrap tests is copied (not moved) and the duplication is noted in the commit body. `tests/preload.ts` arrives with the first I/O-touching migration; the `[test] preload` config is already in `wrap-core/bunfig.toml`.
- **History preserved selectively.** `git filter-repo` for modules >300 LOC with meaningful commit history; smaller or just-rewritten files accept blame loss with `Originating-sha: <sha>` in the commit body.
- **Single-agent dispatch.** Each migration runs as one agent with shell access to both repos (wrap work in the worktree, wrap-core work in canonical). Sequential — one agent finishes (or pauses) before the next.
- **wrap-core ships its own `CLAUDE.md` and `vault/`.** Designed for LLM consumption.

## Module shape conventions

- **Factory + generics for stateful or per-tool-configured modules; namespace-of-functions for pure utilities.** Pure utilities export functions. Modules that own state OR take per-tool params expose `createFoo<T...>(opts: Opts<T...>): Api<T...>` — generics flow through the factory, the opts type, and the returned interface so consumer types reach the call site without casts. The returned `Api` is an interface, not a class; lifecycle (start/stop, dispose) lives in the caller's hands. Tests construct fresh instances; no global state to reset.

- **Generics over interfaces for per-tool values.** When wrap-core takes a per-tool value (response schema, voice, theme overrides, settings registry), expose it as a generic type parameter so types flow through to the consumer. Fall back to a non-generic interface only when the public surface would otherwise carry 3+ type parameters that don't constrain one another (i.e. each could vary independently with no shared shape).

- **Internal organization by size.** Hard threshold: if `index.ts` would exceed 300 non-blank, non-comment lines, split into descriptive kebab-case sibling files; `index.ts` curates re-exports. Sibling files are private — only `exports`-listed paths are importable from outside.

- **Refactor scope: lift wrap-specific deps to params; preserve surface where possible.** Default: narrow refactor. Same public methods/shape; lift theme / schema / voice / etc. to constructor args. Reshape (renaming methods, restructuring API) is allowed when the existing surface bakes in a tool-specific assumption — agent justifies in the commit body. Speculative reduction (cutting methods that aren't used by both wrap and Sweep) is **forbidden** until Sweep is real. (Sweep is real once `~/mysite/sweep/package.json` exists with `wrap-core` as a dependency.)

- **TSDoc on public exports: minimal one-liner.** Each public function/type gets a one-line description above it. Skip `@param` / `@returns` unless a parameter is non-obvious. Expand to full TSDoc (description + `@param` + `@returns` + `@example`) when the function takes ≥3 params, takes an options object with non-obvious fields, or returns a discriminated union.

- **Test classification is judgement.** No mechanical rule. Agent reads tests and decides which are unit-for-the-migrating-module (move to core) vs which exercise broader flows (stay in wrap). When in doubt, leave in wrap.

- **No module migrates without tests.** If wrap has no unit tests for the candidate (or only integration tests that stay in wrap), the agent writes tests in TDD step 1 against the intended pure-framework interface — failing first, passing after step 2.

## Dependencies

- **Peer deps for singleton-required libraries** (`react`, `ink`, `@inkjs/ui`). Each consumer also lists them in its own `package.json`. Install fails loudly if ranges can't unify; never duplicates. Two copies of React (or two Ink runtimes) silently break hooks, contexts, and the rendering tree.
- **`@types/react` is a `devDependency` in both wrap-core and each consumer.** Required for TS to type-check JSX; never resolved at runtime.
- **Direct deps for everything else** (`ai`, `@ai-sdk/*`, `zod`, `jsonc-parser`, etc.). Wrap-core's version pins them; consumers inherit transitively. Each wrap-core release defines a coherent dep set.
- **Identifying which deps to install during a migration.** Scan the migrated source for non-relative imports. Skip `node:*` (Node builtins) and any bare-name import already listed in wrap-core's `peerDependencies` (`react`, `ink`, `@inkjs/ui`). For each remaining dep, run `bun add <name>` (or `bun add -D <name>` for type-only or test-only deps). Match wrap's currently-installed version unless wrap-core already pins a different range.

## Vault structure

Two layers in wrap-core's vault:

- `wrap-core/vault/<concept>.md` — **internals**. Why decisions made, design rationale, deep notes. For LLMs working *inside* wrap-core. Standard concept-note style (terse, what+why-not-how, decisions inline) — see `../wrap/vault/vault-maintenance.md` for the full style rules. Write one when the migration involved a non-obvious refactor (lifted deps, surface reshape, or a rejected alternative). Pure copy-with-rename gets no internals note.

- `wrap-core/vault/wrap-core-api/<concept>.md` — **usage surface**. For LLMs in consumer tools. Compact: frontmatter (`name`, `description`, `package`) → one-paragraph purpose → table of public symbols (Symbol | Shape | Note) → pointer to internals at the bottom. No additional sections.

Consumers symlink the api dir through `node_modules`. The wrap worktree has `vault/wrap-core-api → ../node_modules/wrap-core/vault/wrap-core-api`. The path goes through `node_modules/wrap-core` (itself a `bun link` symlink to wrap-core's source), so it resolves identically from any consumer checkout that has run `bun install`. Sweep gets the same setup later. Symlink is committed in the consumer repo.

`wrap-core/vault/README.md` is created with the first migration that writes any file under `wrap-core/vault/` (api or internals). Lean: intro paragraph + index of concept notes + index of api notes. No invariants, no glossary, no module map (those duplicate wrap-core's `CLAUDE.md`).

**Cross-package stub format.** When a concept spans both repos (e.g. dialog state-machine infra in core + concrete state graph in wrap), each side gets a stub: frontmatter (`name`, one-line description, `Source:`, `See-also: ../<other-repo>/vault/<concept>.md`) plus a single paragraph naming the canonical doc on the other side.

## Cross-package LLM context

Once modules and their vault notes leave wrap, wrap-side LLM sessions stay aware of wrap-core's capabilities through:

- `bun link` symlinks wrap-core into `node_modules/wrap-core/` in each consumer checkout. Source + vault readable at that path during dev.
- wrap-core's `CLAUDE.md` and `vault/README.md` are the entry points; wrap's `CLAUDE.md` carries a pointer (added on the first migration — see TDD step 3).
- The `wrap-core-api` symlink in wrap's vault (resolving through `node_modules/wrap-core`) gives consumer-side LLMs direct access to usage docs as if they were native to the wrap vault.
- Public exports carry minimal TSDoc for IDE-hover surface lookup.

## Picking and planning

**No prescribed migration order.** The agent picks a candidate from the boundary list using judgement — typically leaf-first (modules whose import-graph closure pulls in nothing else from the candidate list). The boundary section's tightly-coupled-clusters note is the canonical guidance for what migrates as a unit.

**Plan first, implement second.** Before executing the TDD recipe, the agent produces a brief plan and pauses for human review. The plan covers:
- Candidate module + import-graph closure (the full migration unit, after running the closure check)
- Wrap-specific deps anticipated to be lifted to parameters
- Test files moving to wrap-core / staying in wrap / new tests to write
- Surface shape (factory or namespace per the conventions; what `index.ts` exports)
- Anticipated surprises or open questions

The plan is a conversation artifact, not a commit. Human reviews; implementation begins on approval.

## Per-migration discipline (TDD)

For each module:

1. **Tests in (failing).**
   - Copy unit tests for the module into `wrap-core/tests/`. Bring helpers + fixtures the tests depend on into `wrap-core/tests/helpers/` (or `tests/fixtures/` for fixture data).
   - Run an import-graph closure check on each helper. If a helper transitively imports unmigrated wrap-only modules (memory, discovery, session, etc.), narrow the helper or include the missing deps in this migration unit.
   - **First I/O-touching migration only:** bring `tests/preload.ts` from wrap. `wrap-core/bunfig.toml` already has the `[test] preload` config in place.
   - **No tests in wrap?** Write them now against the intended pure-framework interface (per the no-untested-module rule).
   - Tests should import from the final path (`wrap-core/<module>` once wired, or relative `../src/<module>` for now). Run `bun test`. Acceptable failure modes at this stage: import-resolution error, type error, or assertion failure. Confirm at least one before proceeding.

2. **Code in, refactored for purity.**
   - Bring source into `src/<module>/index.ts` (split into descriptive kebab-case sibling files for internals if the size threshold is hit). Lift wrap-specific deps to parameters.
   - **First migration only:** add the `exports` map to `wrap-core/package.json` (`"exports": { "./<module>": "./src/<module>/index.ts" }`) and remove the placeholder `"module": "index.ts"` line. Subsequent migrations append entries to the existing `exports` map.
   - Install missing deps (scan imports per [Dependencies](#dependencies)).
   - `bun run check` in wrap-core — tests pass, lint + tsc clean.

3. **Wire wrap.**
   - Verify `"wrap-core": "link:wrap-core"` is a dependency in wrap's `package.json` (run `bun link wrap-core --save` in the consumer checkout if absent — assumes `bun link` was run once in wrap-core, which is one-time setup). Run `bun install` to refresh `node_modules`.
   - Rewire wrap's imports of the migrating module to `wrap-core/<module>`. Search across **all** of `src/` (including `main.ts`, `index.ts`) and `tests/` — entry files and tests frequently import without going through a module dir. Deep imports of the module's internals (e.g. `./<module>/sub.ts`) must rewire too; if the import targets something not in the public surface, either expose it via the module's `index.ts` or refactor wrap to not need it.
   - **First migration only:** append a `## wrap-core dependency` section to wrap's `CLAUDE.md` (after the existing `## Stack` section) with the pointer text below.
   - Run `bun run check` in wrap — tests still pass.

4. **Trim wrap.**
   - Audit type re-exports before deletion: types crossing the module boundary (e.g. `Color` from `core/ansi.ts` consumed by stays-in-wrap `tui/risk-presets.ts`) may need to flow back via `wrap-core/<module>` imports in stays-per-tool files.
   - Delete the original source from wrap and the now-redundant unit tests. (A wrap test is redundant iff its assertions are fully covered by a test that moved. Partial overlap stays.)
   - `bun run check` clean.

5. **Vault.**
   - If the migration involved a non-obvious refactor: write internals note(s) into `wrap-core/vault/<concept>.md`. Wrap's existing vault note for the module either moves entirely to `wrap-core/vault/` or gets rewritten as a stub per the cross-package stub format.
   - Create the api note in `wrap-core/vault/wrap-core-api/<module>.md` per the shape in [Vault structure](#vault-structure).
   - **First vault note in wrap-core (api or internals):** create `wrap-core/vault/README.md` per the shape in [Vault structure](#vault-structure).

### Pointer text for wrap's `CLAUDE.md` (first migration only)

```markdown
## wrap-core dependency

wrap-core is a sibling package providing shared substrate. Linked via `bun link` (`"wrap-core": "link:wrap-core"` in `package.json`); `node_modules/wrap-core/` symlinks to `~/mysite/wrap-core/`. When working on shared substrate (TUI primitives, theme, providers, dialog infra, config), read:
- `node_modules/wrap-core/CLAUDE.md` — wrap-core's conventions and hard rules.
- `vault/wrap-core-api/<concept>.md` — usage docs (symlinked through `node_modules/wrap-core`).
- `node_modules/wrap-core/vault/<concept>.md` — internals, when needed.

The migration plan lives in `vault/impl-specs/wrap-core.md`.
```

## Branch flow

The whole extraction lives on **one branch in each repo** (in wrap, the worktree branch `worktree-wrap-core`; in wrap-core, a parallel branch e.g. `migrate/wrap-core`). Each agent verifies the branch exists in both repos at start; creates from `main` if missing. Commits accumulate as migrations land. No per-migration branches. Sequential: one agent at a time. Human merges to main when all migrations complete.

**Package-level scaffolding belongs on `main`, not the migration branch.** Base files for the package to function (`package.json`, `tsconfig.json`, `biome.json`, `CLAUDE.md`, `.bun-version`, `bunfig.toml`) are prerequisites that exist before any migration; they go on each repo's `main`. Migration-related work — the impl-spec, dep wiring, and module migrations themselves — lives on the migration branch.

**Atomic commits = working states.** Each commit leaves both repos green (`bun run check` passes). Don't commit intermediate states — failing tests, half-rewired imports, dirty types. Within a migration the agent slices into commits at green-state checkpoints; the slicing is the agent's call.

## Escalation when an agent pauses

If a migration hits a semantic coupling that can't be lifted to a param (and lifting would balloon scope):

- Agent commits whatever leaves both repos in a clean state. **Clean = `bun run check` (lint + test) passes in both repos.** If wrap-core is green but wrap is broken (or vice versa), do not commit either side. Half-rewired imports, dirty types, or any state that doesn't satisfy the both-repos-green rule does NOT get committed.
- Agent writes a paused note at `vault/impl-specs/<module>-paused.md` (alongside this spec, in the wrap worktree) describing:
  - the migration attempted
  - the surprise that triggered the pause (the per-tool dep that couldn't be lifted)
  - what alternatives were tried
  - current file state (which parts are committed; which are uncommitted)
- Branch left as-is for human review. Human decides: widen the boundary, decouple separately first, or leave the module per-tool.

## Migrated

None yet.

## Compaction

When the migration completes, this impl-spec compacts into a concept note `vault/wrap-core.md` describing the boundary, module-shape conventions, vault structure, and dependency rules. Delete (work-done): TDD recipe, branch flow, escalation procedure, this impl-spec.
