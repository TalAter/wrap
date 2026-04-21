import type { Key } from "ink";
import { useInput } from "ink";

/** Named keys Ink exposes as booleans on the Key object we care about. */
export type NamedKey = "return" | "escape" | "up" | "down" | "left" | "right" | "space" | "tab";

/**
 * A key trigger is either:
 * - a NamedKey string (e.g. "return"),
 * - a single-character string (e.g. "y", "q", " "), matched case-insensitively against Ink's `input`,
 * - or an object form for modifier combos (e.g. `{ key: "c", ctrl: true }`).
 *
 * Disambiguation: if the string is in NamedKey it matches the named key; otherwise
 * it is treated as a literal char (length must be 1 in that case).
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

const NAMED_KEYS: ReadonlySet<string> = new Set<NamedKey>([
  "return",
  "escape",
  "up",
  "down",
  "left",
  "right",
  "space",
  "tab",
]);

function matchesNamed(name: string, input: string, key: Key): boolean {
  switch (name) {
    case "return":
      return key.return === true;
    case "escape":
      return key.escape === true;
    case "up":
      return key.upArrow === true;
    case "down":
      return key.downArrow === true;
    case "left":
      return key.leftArrow === true;
    case "right":
      return key.rightArrow === true;
    case "space":
      return input === " " && !key.ctrl && !key.meta;
    case "tab":
      return key.tab === true;
    default:
      return false;
  }
}

function matchesChar(ch: string, input: string): boolean {
  if (ch.length !== 1) return false;
  if (input.length !== 1) return false;
  return input.toLowerCase() === ch.toLowerCase();
}

function matches(trigger: KeyTrigger, input: string, key: Key): boolean {
  if (typeof trigger === "object") {
    const wantCtrl = trigger.ctrl === true;
    const wantShift = trigger.shift === true;
    const wantMeta = trigger.meta === true;
    if ((key.ctrl === true) !== wantCtrl) return false;
    if ((key.shift === true) !== wantShift) return false;
    if ((key.meta === true) !== wantMeta) return false;
    return NAMED_KEYS.has(trigger.key)
      ? matchesNamed(trigger.key, input, key)
      : matchesChar(trigger.key, input);
  }

  // Bare trigger — must not fire when modifiers that change meaning are held.
  // ctrl and meta are blocking; shift is tolerated so shift+y ("Y") still matches "y".
  if (key.ctrl || key.meta) return false;
  return NAMED_KEYS.has(trigger) ? matchesNamed(trigger, input, key) : matchesChar(trigger, input);
}

/**
 * Wire a list of key bindings to the current Ink component.
 *
 * Matching order: bindings are evaluated in declaration order, and within each
 * binding triggers are checked in declaration order — first match wins and the
 * rest skip. Object-form triggers require exact modifier match; bare char
 * triggers block on ctrl/meta but tolerate shift.
 */
export function useKeyBindings(
  bindings: readonly KeyBinding[],
  options?: { isActive?: boolean },
): void {
  useInput(
    (input, key) => {
      for (const binding of bindings) {
        const triggers: readonly KeyTrigger[] = Array.isArray(binding.on)
          ? (binding.on as readonly KeyTrigger[])
          : [binding.on as KeyTrigger];
        for (const trigger of triggers) {
          if (matches(trigger, input, key)) {
            binding.do();
            return;
          }
        }
      }
    },
    { isActive: options?.isActive },
  );
}
