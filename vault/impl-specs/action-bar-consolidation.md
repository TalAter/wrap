# Action bar consolidation

> Unify all "bottom-of-dialog key rows" (approve-command ActionBar, wizard KeyHints, ForgetDialog plain text) behind one render component `<ActionBar>`. Unify all dialog `useInput` key handlers behind one hook `useKeyBindings`. Delete the two existing `KeyHints` definitions. No behavior change for users beyond visual consistency.

## Motivation

Today there are three divergent patterns for the same UI element:

- `src/tui/response-dialog.tsx:421-468` — selectable `ActionBar` with underlined hotkeys, colors, selection highlight, left/right nav. Looks good.
- `src/tui/wizard-chrome.tsx:116-137` — `KeyHints` with combo-glyph + label, colors, dividers. Looks fine.
- `src/tui/response-dialog.tsx:399-418` — **duplicate** of wizard's `KeyHints`, copy-pasted because it takes theme as a prop instead of via `getTheme()` hook.
- `src/tui/forget-dialog.tsx:68-71` — plain `<Text>` line with dot `·` dividers and a single muted color. No shared component.

Every dialog also has its own `useInput` hook with ad-hoc key matching. ResponseDialog's confirming handler (lines 256-287) is long and duplicates patterns (escape → dispatch, char match → dispatch, arrow → setState).

The goal is strictly code-level simplification plus one visual fix (ForgetDialog adopts the shared look). No new features.

## Invariants (do not violate)

1. **stdout stays clean.** Action-bar rendering is chrome — goes to stderr via Ink. Never stdout. See `vault/README.md` invariant 1.
2. **No stdin contamination.** The existing `ResponseDialog` stdin drain (`response-dialog.tsx:177-190`) must not be disturbed. `useKeyBindings` uses Ink's `useInput` — same substrate as today.
3. **Plain-language errors.** No user-visible error strings change.
4. **TDD.** Every new module gets a failing test before implementation. See `.claude/skills/testing.md`.

## Non-goals

- Don't change `Checklist` (`src/tui/checklist.tsx`). It owns its own ↑↓/Space/Enter and is used by both `ForgetDialog` and `config-wizard-dialog.tsx` (provider selection). Leave it alone.
- Don't change the session reducer or its event types (`src/session/state.ts:129-170`). `selectedIndex` is local React state in ResponseDialog — do not lift it.
- Don't change the risk-badge pill, stdin drain, dialog border, or any visual outside the bottom row.
- Don't introduce `ActionId` generics. One concrete consumer today.

---

## Primitives

Two new files. Nothing else.

### `src/tui/key-bindings.ts`

```ts
import type { Key } from "ink";
import { useInput } from "ink";

/** Named keys Ink exposes as booleans on the Key object we care about. */
export type NamedKey =
  | "return"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "space"
  | "tab";

/**
 * A key trigger is either:
 * - a NamedKey string (e.g. "return"),
 * - a single-character string (e.g. "y", "q", " "), matched case-insensitively against Ink's `input`,
 * - or an object form for modifier combos (e.g. `{ key: "c", ctrl: true }`).
 *
 * Disambiguation: if the string is in NamedKey it matches the named key; otherwise
 * it is treated as a literal char (length must be 1 in that case).
 *
 * The `(string & {})` trick preserves literal autocomplete on NamedKey while still
 * allowing any single-char string.
 */
export type KeyTrigger =
  | NamedKey
  | (string & {})
  | {
      key: NamedKey | (string & {});
      ctrl?: boolean;
      shift?: boolean;
      meta?: boolean;
    };

export type KeyBinding = {
  on: KeyTrigger | readonly KeyTrigger[];
  do: () => void;
};

/**
 * Wire a list of key bindings to the current Ink component.
 *
 * Matching rules, evaluated in declaration order — first match wins, rest are skipped:
 * 1. Object-form triggers match only if all specified modifiers match AND `key` matches.
 * 2. Bare single-char triggers match only when NO modifiers are held (so "c" doesn't fire on ctrl+c).
 * 3. Bare NamedKey triggers check the corresponding `key.return`/`key.escape`/`key.upArrow` etc.
 * 4. Char comparison is case-insensitive.
 *
 * `isActive` is passed through to `useInput` so callers can gate bindings by dialog state.
 */
export function useKeyBindings(
  bindings: readonly KeyBinding[],
  options?: { isActive?: boolean },
): void;
```

Implementation notes:
- `useInput((input, key) => {...}, { isActive: options?.isActive })`.
- For each binding, resolve `on` to an array, then iterate until one matches.
- Helper `matches(trigger, input, key)`:
  - If `trigger` is an object: check modifiers against `key.ctrl`/`key.shift`/`key.meta` (all must be equal — `undefined` in trigger = must be false/absent in `key`), then recurse on `trigger.key`.
  - If `trigger` is a NamedKey: map to the Ink `Key` boolean (`return → key.return`, `escape → key.escape`, `up → key.upArrow`, `down → key.downArrow`, `left → key.leftArrow`, `right → key.rightArrow`, `space → input === " "`, `tab → key.tab`).
  - Else (single-char string): require `!key.ctrl && !key.shift && !key.meta` (shift tolerated for letters; see test cases), then `input.toLowerCase() === trigger.toLowerCase()`.

Edge cases to cover in tests:
- Bare `"c"` does NOT fire on ctrl+c.
- `{ key: "c", ctrl: true }` fires on ctrl+c.
- Array `on: ["n", "escape"]` fires on either.
- Uppercase input ("Y" from shift+y) matches `on: "y"`.
- Declaration order matters: first matching binding fires, later ones skip.
- `isActive: false` suppresses all bindings.

### `src/tui/action-bar.tsx`

```ts
export type ActionItem = {
  /**
   * The display glyph shown for this item.
   * - Single ASCII letter (A-Z, case-insensitive) rendered as underlined hotkey
   *   INSIDE the label (approve style): `{ glyph: "Y", label: "Yes" }` → `Yes` with `Y` underlined.
   *   Applies only if glyph.toLowerCase() === label[0].toLowerCase(). Otherwise falls back.
   * - Any other glyph rendered as a prefix combo: `{ glyph: "⏎", label: "forget" }` → `⏎ forget`.
   * - Examples: "Y", "⏎", "Esc", "↑↓", "Space".
   */
  glyph: string;
  label: string;
  /** If true, item gets the highlight color even when not focused. */
  primary?: boolean;
};

export function ActionBar(props: {
  items: readonly ActionItem[];
  /**
   * Visual-only. If provided, the item at this index renders with the
   * selection highlight background. Does NOT imply any input behavior —
   * arrow nav and Enter-on-focus are wired entirely by the caller's
   * `useKeyBindings`. ActionBar owns no keys.
   */
  focusedIndex?: number;
}): JSX.Element;
```

Rendering rules (port from existing `ActionBar`/`KeyHints` in `response-dialog.tsx`):

- Outer `<Text>` with leading `"   "` indent (3 spaces), matching current `ActionBar`.
- Items separated by `<Text color={divider}>{"  │  "}</Text>`. No dot `·`. No hardcoded `i === 2` group break — the current approve dialog's primary/secondary split is not preserved as a separate divider; all items use the same divider. (If this regresses the approve dialog's look noticeably, re-introduce via an optional per-item flag in a follow-up; do not add it speculatively.)
- For each item:
  - If glyph is single ASCII letter and matches `label[0]` case-insensitively: render approve-style.
    - Wrap whole token in `<Text backgroundColor={isFocused ? accentBg : undefined}>` with a leading and trailing space for the pill effect (see existing `response-dialog.tsx:454-462`).
    - Inside: `<Text bold underline color={accent}>{label[0]}</Text>` then `<Text color={dimColor} bold={isFocused}>{label.slice(1)}</Text>`.
  - Else (glyph is combo): render KeyHints-style.
    - `<Text bold color={item.primary ? highlight : secondary}>{glyph}</Text>` then `<Text color={muted}>{' ' + label}</Text>`.
    - Focused combo items render the background pill too (to keep selection consistent across all uses).

Colors (reuse existing theme paths from `response-dialog.tsx:421-434`):
- `primary = themeHex(theme.text.primary)`
- `divider = themeHex(theme.text.disabled)`
- `highlight = themeHex(theme.interactive.highlight)`
- `secondary = themeHex(theme.text.secondary)`
- `muted = themeHex(theme.text.muted)`
- `accentBg = themeHex(theme.chrome.accent)`
- `highlightBright` = `theme.interactive.highlight` with `(+10, +20, +20)` clamped to 255 — for focused primary items.

Theme accessed via `getTheme()` (the hook from `src/core/theme.ts`), not a prop. Matches current `KeyHints` in `wizard-chrome.tsx:117`.

---

## Migration

### Step 1 — add primitives with tests

Create `src/tui/key-bindings.ts` and its test `tests/tui/key-bindings.test.ts`. Tests must cover the edge cases listed above. Use Ink test harness already in use in the repo (look at existing `tests/tui/*.test.ts` for patterns).

Create `src/tui/action-bar.tsx` and `tests/tui/action-bar.test.ts`. Tests render each rendering mode (approve-style letter, combo-prefix glyph) and verify focused highlight renders at the given index.

Files do not yet have any callers. Commit: `Add action-bar and key-bindings primitives`.

### Step 2 — migrate ResponseDialog

File: `src/tui/response-dialog.tsx`.

Changes:

1. Delete local `KeyHints` function (lines 399-418).
2. Delete local `ActionBar` function (lines 421-468).
3. Delete `HintItem` type (line 397).
4. Replace the two `useInput` hooks (lines 241-287) with one `useKeyBindings` call built from state-keyed binding lists. Sketch:

```ts
// Per-state binding lists. `ACTION_ITEMS` retained as the source of truth
// for the confirming bar's items + hotkeys; each item gains a `do` callback
// computed from dispatch.
const dispatchAction = (id: ActionId) => dispatch({ type: "key-action", action: id });

const confirmingBindings: KeyBinding[] = [
  { on: ["n", "q", "escape", { key: "c", ctrl: true }], do: () => dispatchAction("cancel") },
  { on: "y", do: () => dispatchAction("run") },
  { on: "e", do: () => dispatchAction("edit") },
  { on: "f", do: () => dispatchAction("followup") },
  { on: "c", do: () => dispatchAction("copy") },
  { on: "left",  do: () => setSelectedIndex((i) => Math.max(0, i - 1)) },
  { on: "right", do: () => setSelectedIndex((i) => Math.min(ACTION_ITEMS.length - 1, i + 1)) },
  { on: "return", do: () => {
      const item = ACTION_ITEMS[selectedIndex];
      if (item) dispatchAction(item.id);
    } },
];

const escOnlyBindings: KeyBinding[] = [
  { on: "escape", do: () => dispatch({ type: "key-esc" }) },
];

useKeyBindings(confirmingBindings, { isActive: state.tag === "confirming" });
useKeyBindings(escOnlyBindings, {
  isActive:
    state.tag === "editing" ||
    state.tag === "composing" ||
    state.tag === "processing" ||
    state.tag === "executing-step",
});
```

Notes:
- `"c"` both runs Copy and participates in ctrl+c (cancel). Declaration order: put the cancel binding first — `on: [..., { key: "c", ctrl: true }]` matches only with ctrl held; bare `"c"` only matches without modifiers; both can coexist safely because of the modifier guard in `matches()`.
- Stdin drain, spinner, risk preset, TextInput — all unchanged.
- `ACTION_ITEMS` stays in `response-dialog.tsx` (dialog-specific). Keep the existing shape but note its `hotkey` field is now redundant with `label[0]` — leave it for now to minimize diff; drop in a follow-up if desired.

5. Replace the five JSX sites (`response-dialog.tsx:382-392`) with `<ActionBar>`:

```ts
const ACTION_ITEMS_BAR: readonly ActionItem[] = ACTION_ITEMS.map((a) => ({
  glyph: a.label[0].toUpperCase(),
  label: a.label,
  primary: a.primary,
}));

// ...

{state.tag === "editing" ? (
  <ActionBar items={EDIT_HINT_ITEMS} />
) : state.tag === "composing" ? (
  <ActionBar items={COMPOSE_HINT_ITEMS} />
) : state.tag === "processing" ? (
  <ActionBar items={PROCESS_HINT_ITEMS} />
) : state.tag === "executing-step" ? (
  <ActionBar items={EXECUTING_STEP_HINT_ITEMS} />
) : (
  <>
    <Text>{"   Run command? "}</Text>
    <ActionBar items={ACTION_ITEMS_BAR} focusedIndex={selectedIndex} />
  </>
)}
```

Where the existing `EDIT_HINTS`/`COMPOSE_HINTS`/`PROCESS_HINTS`/`EXECUTING_STEP_HINTS` constants (`response-dialog.tsx:38-47`) are renamed and reshaped:

```ts
const EDIT_HINT_ITEMS: readonly ActionItem[] = [
  { glyph: "⏎",   label: "to run", primary: true },
  { glyph: "Esc", label: "to discard changes" },
];
// …and so on for COMPOSE / PROCESS / EXECUTING_STEP, matching existing text.
```

The `"Run command? "` leader is kept inline via composition (caller renders it above or alongside ActionBar). It's not an ActionBar prop.

Run `bun run lint` and `bun test`. All existing ResponseDialog tests must continue to pass — if any assert on the old ActionBar/KeyHints internal structure, update them to match the new renderer.

Commit: `ResponseDialog: use shared ActionBar and useKeyBindings`.

### Step 3 — migrate wizard call sites

Files:
- `src/tui/wizard-chrome.tsx` — delete `KeyHints` (lines 116-137) and its `HintItem` type (line 114). The `getWizardStops`, `WIZARD_CONTENT_WIDTH`, `wizardLabelPill`, `wizardSegs` exports stay.
- `src/tui/config-wizard-dialog.tsx` — 5 call sites at lines 256, 313, 357, 380, 422. Swap each `<KeyHints items={[...]}>` for `<ActionBar items={[...]}>` and rename keys: `{ combo: X, label: Y, primary?: Z }` → `{ glyph: X, label: Y, primary?: Z }`. Remove `KeyHints` import; add `ActionBar` import.
- `src/tui/welcome-section.tsx` — 1 call site at lines 37-44. Same swap. Also remove `KeyHints` from the `wizard-chrome` import.
- `src/tui/nerd-icons-section.tsx` — 1 call site at lines 71-76. Same swap.

Each wizard screen's own `useInput` calls (e.g. `welcome-section.tsx:22-25`, `nerd-icons-section.tsx:30-38`, `config-wizard-dialog.tsx:332-340`, `:368-370`, `:401-409`) should also migrate to `useKeyBindings` for consistency. This is a pure mechanical swap — declaration-order matters only for the ResponseDialog conflict, not here.

Example for `welcome-section.tsx`:

```ts
useKeyBindings([
  { on: "escape", do: onCancel },
  { on: "return", do: onDone },
]);
```

Commit: `Wizard: use shared ActionBar and useKeyBindings`.

### Step 4 — migrate ForgetDialog

File: `src/tui/forget-dialog.tsx`.

Changes:

1. Replace the plain `<Text>` hint line (lines 68-71) with `<ActionBar>`:

```tsx
<ActionBar items={[
  { glyph: "↑↓",    label: "move" },
  { glyph: "Space", label: "toggle" },
  { glyph: "⏎",     label: "forget", primary: true },
  { glyph: "Esc",   label: "cancel" },
]} />
```

2. Replace the inline `useInput` (lines 40-42) with `useKeyBindings([{ on: "escape", do: onCancel }])`.

3. **Width check.** Current `CONTENT_WIDTH = 52` (line 27). The new KeyHints-style row is approximately:
   - `"   "` indent (3) + `↑↓` (2) + `" move"` (5) + divider `"  │  "` (5) + `Space` (5) + `" toggle"` (7) + divider (5) + `⏎` (~2) + `" forget"` (7) + divider (5) + `Esc` (3) + `" cancel"` (7) ≈ 56.

   This overflows. Options, pick one at implementation time:
   - Bump `CONTENT_WIDTH` to 60.
   - Shorten labels (e.g. drop the leading space convention, or use shorter words).
   - Drop `↑↓ move` and `Space toggle` — they're documented by Checklist's pointer (`❯`) and checkbox — keep only `⏎ forget` + `Esc cancel`.

   Render and eyeball it. If width budget is tight, prefer bumping `CONTENT_WIDTH`; no other dialog shares this constant.

4. `Checklist` stays untouched — it keeps owning ↑↓/Space/Enter. The ActionBar row is decorative reminder only; the actual Enter is handled by Checklist's internal `useInput` which calls `onSubmit` (`checklist.tsx:53-54`), which calls `onSubmit` prop passed by ForgetDialog (line 66), unchanged.

Commit: `ForgetDialog: consistent action bar`.

### Step 5 — vault note

Add a short note under `vault/` at the appropriate location (probably `vault/tui.md` already describes the dialog). Find the mention of "Action bar" in the glossary (`vault/README.md:71`) — the definition stands. Add a one-line pointer in `vault/tui.md` to the new `src/tui/action-bar.tsx` file as the single renderer for the bottom row, and to `src/tui/key-bindings.ts` as the single dialog key hook.

Follow `vault/vault-maintenance.md` conventions (frontmatter `Source:` and `Last-synced:` if appropriate).

Commit: `Vault: note action-bar + key-bindings as shared primitives`.

---

## Testing strategy

Per `.claude/skills/testing.md`, TDD. Write failing tests first for each new module.

Targeted test files:
- `tests/tui/key-bindings.test.ts` — pure unit tests for the hook, rendered inside a test harness component. Verify each matching rule.
- `tests/tui/action-bar.test.ts` — snapshot-ish tests using `ink-testing-library` (already in use per existing tui tests). Assert rendered output includes expected glyphs, dividers, and selection highlighting.

For migrated call sites, the existing dialog tests must continue to pass. Run these targeted suites after each step:

```
bun test tests/tui/response-dialog.test.ts
bun test tests/tui/forget-dialog.test.ts
bun test tests/tui/config-wizard-dialog.test.ts   # if exists
bun test tests/tui/welcome-section.test.ts         # if exists
bun test tests/tui/nerd-icons-section.test.ts      # if exists
bun test tests/tui/checklist.test.ts
```

Do NOT run the full suite after every step; targeted runs per the project's testing note.

Lint + typecheck run automatically via the Stop hook; no need to invoke manually as a final check.

---

## Pitfalls / watchouts

1. **Declaration order of bindings matters.** ResponseDialog's confirming bindings put cancel (with `{key:"c",ctrl:true}`) in the same list as Copy (bare `"c"`). Both work only because `matches()` distinguishes modifier presence. Document in the `useKeyBindings` JSDoc and cover in tests.

2. **Uppercase vs lowercase chars.** Ink may send `"Y"` when shift+y pressed. Char matching is case-insensitive. Verify with a test.

3. **Stdin drain stays.** `response-dialog.tsx:177-190` is load-bearing — prevents buffered Enter from auto-confirming. Do not remove.

4. **`selectedIndex` remains local React state** in ResponseDialog. Not session state. The `useEffect` that resets it on tag transition (`response-dialog.tsx:164-168`) stays.

5. **`ActionBar` never owns `useInput`.** Every behavior is wired by the parent's `useKeyBindings`. `focusedIndex` is decoration only.

6. **Don't consolidate Checklist's keys into the new primitive.** Checklist is shared with provider selection; changing it risks breaking the wizard flow. Explicitly out of scope.

7. **ForgetDialog width overflow** — see Step 4, #3. Pick the fix at implementation time by rendering and eyeballing. Do not guess.

8. **`primary: boolean` semantics** changed slightly: today it's a meaningful "first-tier action" signal in ResponseDialog's items, and a "highlight this combo" signal in KeyHints. In the unified `ActionItem`, `primary` = "use highlight color". Both uses converge. The visual for non-primary items becomes the existing secondary color. Verify the approve dialog still reads as primary/secondary grouped.

9. **`ACTION_ITEMS` hotkey field redundant** with `label[0]`. Leave for now — dropping it is a separate cleanup, not in scope of this plan.

---

## File inventory

New:
- `src/tui/key-bindings.ts`
- `src/tui/action-bar.tsx`
- `tests/tui/key-bindings.test.ts`
- `tests/tui/action-bar.test.ts`

Modified:
- `src/tui/response-dialog.tsx` — delete local `KeyHints`, local `ActionBar`, `HintItem`; rewire `useInput` via `useKeyBindings`; swap JSX to `<ActionBar>`.
- `src/tui/wizard-chrome.tsx` — delete `KeyHints` + `HintItem`.
- `src/tui/config-wizard-dialog.tsx` — swap 5 `KeyHints` sites to `ActionBar`, migrate `useInput` blocks to `useKeyBindings`.
- `src/tui/welcome-section.tsx` — swap 1 `KeyHints` site, migrate `useInput`.
- `src/tui/nerd-icons-section.tsx` — swap 1 `KeyHints` site, migrate `useInput`.
- `src/tui/forget-dialog.tsx` — swap plain text hint for `ActionBar`, migrate `useInput`; possibly bump `CONTENT_WIDTH`.
- `vault/tui.md` — pointer to new primitives.
- `vault/impl-specs/action-bar-consolidation.md` — delete this file after all steps merge (per `vault/README.md`: impl-specs are deleted after implementation).

Untouched (confirm at review time):
- `src/tui/checklist.tsx`
- `src/session/state.ts`, `src/session/reducer.ts`, `src/session/session.ts`
- `src/tui/dialog.tsx`
- `src/tui/text-input.tsx`
- `src/tui/pill.tsx`, `src/tui/risk-presets.ts`
- `src/core/theme.ts`

---

## Open questions

None blocking. At implementation time, decide:
- ForgetDialog width fix (Step 4, #3).
- Whether to drop the redundant `hotkey` field on `ACTION_ITEMS` in a follow-up commit.
