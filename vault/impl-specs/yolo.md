# Yolo Mode

> Non-interactive mode. No TUI, no confirmation dialogs — commands auto-execute regardless of risk level.

**Status:** Spec complete, not built.

---

## Motivation

Default mode pauses medium/high-risk commands for user confirmation via an Ink TUI dialog. This is the right default, but power users in sandboxed environments, CI pipelines, or rapid-iteration workflows want to skip the gate entirely. Yolo mode is the `-y` / `--yes` / `--force` flag common in CLI tools — explicit opt-in to skip all interactive prompts.

---

## Behavior

Yolo mode is identical to default mode with two exceptions:

1. **No confirmation dialog.** Final commands auto-execute regardless of `risk_level`. The reducer skips the `confirming` state entirely — all commands route directly to `exiting { kind: "run" }`.
2. **Non-final steps execute inline regardless of risk.** In default mode, non-final medium/high commands exit the generator for dialog confirmation. In yolo, the runner treats all non-final commands as inline-execute (same path as non-final low-risk today).

Everything else — spinner, chrome notifications, step explanations, memory updates, verbose output, retry logic, answer-mode output — is unchanged.

### What yolo does NOT change

- LLM still reports `risk_level` on every response (useful for logging, verbose output).
- Local rule engine (when built) still runs and escalates risk for logging. It just doesn't gate execution.
- Retry/error handling is identical to default: malformed LLM responses retry per existing logic, executed commands are fire-and-forget (Wrap doesn't inspect exit codes for retry).
- Answer-mode responses still print to stdout and exit 0.
- The `exhausted` / `aborted` / `error` outcomes are unchanged.
- Non-TTY is no longer blocked. The no-TTY check in `pumpLoop` that blocks non-low commands when `!process.stderr.isTTY` does not apply in yolo — there's nothing to confirm anyway.

### Verbose command echo

Not a behavioral change — verbose already logs various details to stderr. This spec just calls for adding a `verbose(`Running: ${command}`)` line before command execution, in both default and yolo modes. Especially useful in yolo where no dialog previews the command.

---

## Configuration

Yolo is a boolean setting. Full layering follows existing precedence: **CLI > env > file > default**.

### Setting definition

```ts
// settings.ts
yolo: {
  type: "boolean",
  description: "Skip confirmation dialogs — auto-execute all commands",
  usage: "w --yolo",
  flag: ["--yolo"],
  env: ["WRAP_YOLO"],
  default: false,
}
```

### Config file

```jsonc
// ~/.wrap/config.jsonc
{
  "yolo": true
}
```

### Config type

```ts
// config.ts — add to Config (optional) and ResolvedConfig (required)
export type Config = {
  // ... existing fields
  yolo?: boolean;
};

export type ResolvedConfig = Config & {
  // ... existing fields
  yolo: boolean;
};
```

### Invocation examples

```bash
# Per-invocation flag
w --yolo find all typescript files modified today

# Environment variable
WRAP_YOLO=1 w deploy to staging

# Persistent config (always yolo)
# Set "yolo": true in ~/.wrap/config.jsonc

# Combined with other flags
w --yolo --verbose delete all .DS_Store files recursively
```

The `wy` shell alias is a planned future convenience (see SPEC.md §4) but out of scope for this feature. It will be wired when mode detection from `argv[0]` / symlink name lands.

---

## Implementation touch points

### 1. `config/settings.ts` — add yolo to SETTINGS

Add the `yolo` entry. The resolver, modifier specs, and help output all derive from SETTINGS automatically.

### 2. `config/config.ts` — add to Config and ResolvedConfig

`yolo?: boolean` on Config, `yolo: boolean` on ResolvedConfig. The drift-check type ensures the default is required.

### 3. `session/reducer.ts` — skip dialog in `reduceThinking`

`reduceThinking` handles what happens when the LLM returns a final result during the initial "thinking" phase. Today: low-risk → auto-execute (skip dialog), everything else → `confirming` state (mounts TUI dialog). With yolo: check `getConfig().yolo` before the risk check. If yolo, all commands take the auto-execute path regardless of risk level.

### 4. `core/runner.ts` — inline-execute non-final commands in yolo

Today non-final commands exit the generator for dialog confirmation unless they're low-risk. With yolo, all non-final commands take the inline-execute path regardless of risk — same existing path (step-running event, executeShellCommand capture, step-output, transcript push).

### 5. `session/session.ts` — skip no-TTY block in yolo

The no-TTY block in `pumpLoop` fires **before** the event reaches the reducer — it intercepts the generator's final result and dispatches `block` instead of `loop-final`. Without a yolo check here, a non-low command in a no-TTY yolo context gets blocked before the reducer's yolo logic ever runs. Add `&& !getConfig().yolo` to the existing condition.

### 6. Verbose command echo

In `finaliseOutcome` (session.ts), before `executeShellCommand`:

```ts
case "run": {
  verbose(`Running: ${outcome.command}`);
  const exec = await executeShellCommand(outcome.command, { ... });
  // ...
}
```

This is not yolo-specific — it's useful in both modes. But it's especially important in yolo where no dialog previews the command.

---

## What is NOT in scope

- **`wy` alias / argv[0] detection** — separate feature (SPEC.md §11, todo.md). Requires shell setup, noglob wiring, rc file editing.
- **Local rule engine** — designed in safety.md, not yet built. When it lands, yolo bypasses it (decision: bypass everything).
- **confirm-all mode** — opposite of yolo (confirm even low-risk). Separate feature.
- **force-cmd / force-answer** — orthogonal axes (response-type constraints). Can be combined with yolo in the future.

---

## Safety note

Yolo mode disables all safety gates. The LLM could hallucinate `rm -rf /` and it will execute immediately. This is by design — the user explicitly opted in. The setting name ("yolo") and description make the risk clear.

When the local rule engine is built: **yolo bypasses the rule engine too.** The rule engine exists to catch LLM misclassification, but yolo's contract is "no gates, period." If a user wants safety-with-convenience, default mode (or future confirm-all) is the answer.

---

## Test plan

1. **Flag parsing:** `--yolo` sets `getConfig().yolo === true`.
2. **Env var:** `WRAP_YOLO=1` sets yolo.
3. **Config file:** `"yolo": true` in config.jsonc sets yolo.
4. **Precedence:** CLI > env > file > default. `--yolo` overrides `WRAP_YOLO=0`. `WRAP_YOLO=0` disables yolo (env value parsed, not presence-only).
5. **Reducer: yolo skips dialog.** Mock a medium-risk final command → reducer returns `exiting { kind: "run" }` instead of `confirming`.
6. **Reducer: yolo skips dialog for high-risk.** Same as above with high-risk.
7. **Runner: yolo inlines non-final med/high.** With yolo=true, a non-final medium command executes inline (step-running event emitted) instead of exiting the generator.
8. **No-TTY unblocked.** With yolo=true and `!process.stderr.isTTY`, a medium-risk command dispatches `loop-final` instead of `block`.
9. **Answer mode unchanged.** Yolo + answer-type response → stdout output, exit 0 (no difference from default).
10. **Verbose echo.** With `--verbose`, the final command appears on stderr before execution.
11. **Default mode unchanged.** Without yolo, all existing behavior is preserved (regression).
