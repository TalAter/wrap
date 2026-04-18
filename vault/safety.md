---
name: safety
description: Risk classification, execution gates, local rule engine, prompt injection defenses
Source: src/session/reducer.ts, src/session/session.ts, src/core/round.ts, src/core/runner.ts, src/config/settings.ts
Last-synced: e417d75
---

# Safety

Wrap executes LLM-generated shell commands. The LLM is both generator and safety judge — single point of failure. Safety is layered so no single component's failure leads to dangerous execution.

| Layer | Status |
|-------|--------|
| LLM risk classification (`low`/`medium`/`high`) | Built |
| Local rule engine (deterministic, escalate-only) | Planned |
| Execution gate (auto-exec / dialog / block) | Built |
| Adversarial eval (red-team examples, weight 3.0) | Partial |
| Prompt injection resistance (trust fence, nonces) | Planned |

## Execution gate

- `low` → auto-execute on initial round.
- `medium` / `high` → confirmation dialog.
- No TTY + non-low on initial round → block, stderr error, exit non-zero.
- Non-final low → execute inline without confirmation. Non-final medium/high → dialog confirms before step runs. See [[multi-step]].
- Non-final steps should be `low`. Non-low non-final retried once in-round asking for a low-risk alternative. If still non-low → routes through dialog confirmation (`executing-step`). See [[multi-step]].
- Inside an already-mounted dialog (follow-up / processing): even `low` opens the dialog — user is mid-refinement.

## Modes

Gate behaviour per mode:

- **default** — auto-exec low; confirm medium/high. Implemented.
- **yolo** — auto-exec everything. Implemented. See below.
- **force-cmd** — as default; forces `type: command`. Planned.
- **force-answer** — no execution possible (`type: reply`). Planned.
- **confirm-all** — confirm every command regardless of level. Planned.

### Yolo

Opt-in skip of all confirmation gates. Enabled via `--yolo`, `WRAP_YOLO`, or `yolo: true` in config. Two behavioural deltas from default:

1. **No confirmation dialog.** `reduceThinking` routes every final command directly to `exiting { kind: "run" }` regardless of `risk_level`.
2. **Non-final steps inline regardless of risk.** `runLoop` broadens its inline-step condition to include medium/high when yolo is on — probes run inline instead of exiting the generator for dialog confirmation.

The no-TTY block in `pumpLoop` is also skipped in yolo — there's nothing to confirm.

**What yolo does NOT change:** LLM still reports `risk_level` (logged for audit). Rule engine (when built) still runs and escalates for logging. Retry/error handling identical. Answer-mode responses still print to stdout and exit 0. `exhausted` / `aborted` / `error` outcomes unchanged.

**Yolo × rule engine:** yolo bypasses the rule engine too. The rule engine exists to catch LLM misclassification, but yolo's contract is "no gates, period." Users who want safety-with-convenience should use default mode (or future confirm-all).

**Safety note.** Yolo disables every gate. The LLM could hallucinate `rm -rf /` and it will execute immediately. This is by design — the user explicitly opted in. The setting name and description make the risk clear.

**Invocation**

```bash
w --yolo find all typescript files modified today
WRAP_YOLO=1 w deploy to staging
# or "yolo": true in ~/.wrap/config.jsonc
```

## Local rule engine (planned)

Fast deterministic pattern matching after LLM response parse, before the execution gate. **Can only escalate risk, never lower it.** `effective = max(llm_risk, rule_risk)`.

Why: LLMs can be fooled (indirect phrasing, injection, weak models). Regex cannot. Runs in microseconds, zero tokens, every pattern auditable.

Planned patterns: `rm -rf` → high, `sudo` → medium, `dd if=` → high, `mkfs` → high, pipe-to-shell → high, `git reset --hard` → medium, base64-decode-and-execute → high. False positives intentional — a confirm is one keypress; a false-negative is unrecoverable.

**Logging:** both `llm_risk` (what the LLM returned) and `effective_risk` (after rule escalation) go in the round log. Only `effective_risk` gates flow — dialog, execution, retry-on-error. Keeping both lets auditors see where the rule engine intervened.

## Prompt injection resistance (planned)

Injection surfaces: piped input, probe/step results, error messages, thread history.

Planned defenses:
- **Trust fence** — instruction between untrusted context and user request. Leverages LLM recency bias. Build first.
- **System instruction** — labels untrusted content as data.
- **Nonce delimiters** — random boundary markers around untrusted sections. Attacker can't predict the nonce.
- **Rule engine** — catches dangerous commands regardless of how elicited.
- **Adversarial eval** — measures boundary effectiveness.

## Invariant

- **Effective risk is monotone.** Rule engine can only escalate, never lower. This is the design constraint for when it's built.

## Decisions

- **False positives over false negatives.** `chmod +x` → medium. One keypress to confirm; destructive false-negative is unrecoverable.
- **Small, readable pattern list.** If a reviewer can't scan it in 30 seconds, it's too big.
- **Layered defenses.** No single defense suffices. Fence + instruction + nonce + rules + eval.
