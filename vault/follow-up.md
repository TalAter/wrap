---
name: follow-up
description: In-dialog command refinement — composing, processing, transcript, round budget
Source: src/session/reducer.ts, src/session/session.ts, src/core/transcript.ts
Last-synced: c54a1a5
---

# Follow-up

Refine a command from inside the dialog. The LLM receives the full transcript plus follow-up text as a new round and returns an updated command. Dialog stays mounted, updates in place.

Distinct from **continuation** (planned) — continuation resumes a previous thread in a new invocation.

## State flow

```
confirming ──(key:f)──► composing ──(submit)──► processing ──(loop-final)──► confirming
                            ▲                        │
                            └───────(key-esc)────────┘
```

- `composing` — TextInput with placeholder `actually...`. Empty submit is a no-op.
- `processing` — follow-up text shown read-only. `Esc` aborts the in-flight loop (AbortController cancelled BEFORE reducer runs), preserves `state.draft` so user can edit-and-resubmit.
- `confirming` — updated command. Even a low-risk result stays in dialog (user asked for refinement — expects to see before run).

Late-arriving `loop-final` after abort → dropped defensively.

## Transcript

The previous `runLoop` pushes a `candidate_command` turn before returning. Coordinator appends `user:{followupText}` on top. Next call sees `[..., candidate_command, user]` — no message-history hygiene needed. `buildPromptInput` renders `candidate_command` as an assistant turn.

Runner is oblivious to follow-ups — it takes a transcript and drains its round budget.

## Round budget

`LoopState.budgetRemaining` resets to `maxRounds` on every follow-up. `roundNum` is monotonic and never resets. Unlimited chaining falls out for free.

## Logging

`Round.followup_text` set on the first round of each non-initial loop. Subsequent rounds in the same call leave it unset. First user turn lives on `LogEntry.prompt`, not here.

Why per-round not full transcript: system prompt / memory / context would duplicate across entries; per-round shape is what eval consumes.

## Decisions

- **Budget resets per follow-up.** Each refinement gets a full budget. Prevents "stuck after 2 probes" UX.
- **Low-risk asymmetry.** Initial low → auto-exec. Follow-up low → dialog stays open. The user is engaged and expects to confirm. See [[session]].
- **Runner doesn't know about follow-ups.** Coordinator bumps budget, appends turn, starts new loop. Same machinery for [[multi-step]] confirmed steps.
- **Continuation (planned) can't tee child output.** Violates "Wrap disappears during exec" — see [[session]]. Thread storage will likely be stdin/LLM-turn only.
