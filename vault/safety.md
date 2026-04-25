---
name: safety
description: Risk classification, execution gates, local rule engine, prompt injection defenses
Source: src/session/, src/core/round.ts, src/core/runner.ts
Last-synced: 0a22f2a
---

# Safety

Wrap executes LLM-generated shell commands. The LLM is both generator and safety judge — single point of failure. Defenses are layered so no single component's failure leads to dangerous execution.

| Layer | Status |
|-------|--------|
| LLM risk classification (`low`/`medium`/`high`) | Built |
| Local rule engine (deterministic, escalate-only) | Planned |
| Execution gate (auto-exec / dialog / block) | Built |
| Adversarial eval | Partial |
| Prompt injection resistance | Planned |

## Execution gate

- `low` auto-executes on the initial round; `medium`/`high` open the confirmation dialog.
- No TTY + non-low → block with stderr error and non-zero exit. There's no one to confirm.
- Inside an already-mounted dialog (follow-up / processing) every level routes through the dialog — the user is mid-refinement.
- Non-final steps should be `low`; non-low non-final retries once for a low alternative, otherwise routes through dialog confirmation. See [[multi-step]].

## Modes

- **default** — auto-exec low; confirm medium/high. Built.
- **yolo** — every gate off. Built.
- **force-cmd**, **force-answer**, **confirm-all** — planned.

### Yolo

Opt-in via flag, env, or config. Skips the confirmation dialog and the no-TTY block, and runs non-final steps inline regardless of risk. The LLM still reports risk (logged for audit) and the rule engine (when built) still escalates for logging — yolo's contract is "no gates," not "no observation."

By design, yolo will execute hallucinated `rm -rf /` immediately. The setting name and description make that clear. Users wanting safety-with-convenience should use default mode (or future confirm-all). Yolo bypasses the rule engine too — same contract.

## Local rule engine (planned)

Fast deterministic pattern matching after LLM parse, before the gate. **Escalate-only:** `effective = max(llm_risk, rule_risk)`. Microseconds, zero tokens, every pattern auditable.

Why: LLMs can be fooled by indirect phrasing or injection. Regex cannot. Examples: `rm -rf`, `sudo`, `dd if=`, `mkfs`, pipe-to-shell, `git reset --hard`, base64-decode-and-execute. Both `llm_risk` and `effective_risk` log so auditors see where rules intervened.

## Prompt injection (planned)

Untrusted surfaces: attached input, probe/step results, error messages, thread history. Planned defenses — trust fence (recency-bias instruction between untrusted context and user request, build first), system instruction labelling untrusted content as data, nonce delimiters around untrusted sections, the rule engine, and adversarial eval.

## Decisions

- **False positives over false negatives.** A confirm is one keypress; a destructive false-negative is unrecoverable.
- **Effective risk is monotone.** Rules can only escalate.
- **Small, scannable pattern list.** If a reviewer can't read it in 30 seconds it's too big.
- **Layered defenses.** No single layer suffices.
