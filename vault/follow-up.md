---
name: follow-up
description: In-dialog command refinement — composing, processing, transcript, round budget
Source: src/session/, src/core/transcript.ts
Last-synced: 0a22f2a
---

# Follow-up

Refine a command from inside the dialog. The LLM gets the full transcript plus follow-up text as a new round and returns an updated command. Dialog stays mounted, updates in place.

Distinct from **continuation** (planned) — that resumes a previous thread in a new invocation.

## Flow

Confirming → composing (text input) → processing → confirming again with the updated command. Esc from processing aborts the in-flight loop and preserves the draft so the user can edit and resubmit. Late-arriving completion events after abort are dropped defensively.

Even a low-risk follow-up result stays in the dialog — the user asked for a refinement and expects to see it before it runs.

## Transcript

Before returning, the previous loop pushes a candidate-command turn. The coordinator appends the user's follow-up on top. The next call sees a clean `[..., candidate, user]` tail — no message-history surgery. Runner is oblivious to follow-ups; it takes a transcript and drains its budget.

## Round budget

Budget resets to `maxRounds` on every follow-up; the round counter is monotonic and never resets. Unlimited chaining falls out for free.

## Logging

Per-round shape with the follow-up text recorded on the first round of each non-initial loop. The first user prompt lives on the entry, not on a round. Per-round (not full transcript) because system prompt / memory / context would duplicate across entries; per-round shape is what eval consumes.

## Decisions

- **Budget resets per follow-up.** Prevents "stuck after 2 probes" UX.
- **Low-risk asymmetry.** Initial low → auto-exec. Follow-up low → dialog stays open. See [[session]].
- **Runner doesn't know about follow-ups.** Coordinator bumps the budget, appends the turn, starts a new loop — same machinery as [[multi-step]] confirmed steps.
- **Continuation can't tee child output.** Violates "Wrap disappears during exec" — see [[session]]. Thread storage will be stdin/LLM-turn only.
