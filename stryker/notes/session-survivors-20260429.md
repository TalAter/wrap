# session.ts mutation survivors — 2026-04-29

Mutation run on `src/session/session.ts` produced 200 surviving mutants. 5
were genuinely equivalent and were added to `stryker-ignore.yaml` on `main`.
The remaining 195 are not equivalent — they would change observable behavior —
but the headless test environment cannot reach the code paths that would
catch them.

Mutation score: 36.31% (88 killed / 26 timeout / 200 survived / 0 errors).
Run time: 87 minutes.

## Breakdown

| Count | Region (lines)                              | Why current tests don't reach it |
|------:|---------------------------------------------|----------------------------------|
|    91 | dispatch + post-transition hooks (140–225)  | esc-handling, processing-followup, processing-interactive, editor-handoff, executing-step branches all fire only after the Ink dialog dispatches dialog-originated events |
|    35 | state init + router predicate (97–138)      | interactive bootstrap requires `prompt==="" && stdin.isTTY===true`; router predicate fires only during dialog states |
|    26 | runConfirmedStep (227–254)                  | invoked only after the user confirms a non-final med/high step in the dialog |
|    25 | syncDialog (256–284)                        | body runs only when `state.tag` is in `isDialogTag` (mounting, rerendering, tearing down a real Ink alt-screen) |
|    15 | pumpLoop event handling (373–436)           | abort gates + `followup_text` stamping require dialog-driven aborts and follow-ups |
|     2 | main loop interactive-bootstrap branch (319, 321) | same TTY=true requirement as L97 |
|     1 | piped flag for assemblePromptScaffold (90)  | covered by upstream tests but not reasserted at this call site |

## Existing test coverage (intentional gap)

`tests/session.test.ts` covers what's exercisable without a TTY:
- low-risk auto-exec
- plain replies
- exhaustion
- blocked-no-TTY
- multi-round step→reply

Everything dialog-driven is delegated to component-level tests
(`dialog.test.tsx`, `response-dialog.test.tsx`) and reducer tests
(`session-reducer.test.ts`). The session-level orchestration —
post-transition hooks, dispatch routing, mount/teardown sequencing — has no
test that mounts a real Ink dialog and drives keystrokes.

## Suggested paths forward

1. **Ink TTY harness for session tests.** Build a helper around
   `ink-testing-library` (already a dev dependency) that lets `runSession`
   mount its dialog into a virtual stdin/stdout pair, drive synthetic
   keypresses, and assert on exit code + log entries. This would unlock most
   dispatch / runConfirmedStep / syncDialog survivors. The component tests
   show the pattern works at the component level — the missing piece is a
   test seam in `dialog-host.ts` to swap the real Ink mount for the testing
   one.

2. **Extract orchestration to a pure module.** The four `if (entered &&
   state.tag === ...)` blocks at L164/173/193/218 are pure data-flow: read
   state, push to transcript, call `startPumpLoop`/`runConfirmedStep`.
   Pulling them into a `dispatchSideEffects(prev, next, ctx)` function with
   injected dependencies would make the branch logic unit-testable without
   any TTY. Roughly 60 of the surviving mutants are killable this way.

Either approach is a real refactor and shouldn't happen inside the
mutation-survivor routine — escalating for human direction.

## Already-ignored equivalent mutants

| Line | Mutator              | Reason |
|-----:|----------------------|--------|
|  462 | ObjectLiteral        | `{ mode: "inherit" }` → `{}` falls through to inherit branch in `executeShellCommand`; same observable result |
|  462 | StringLiteral        | `"inherit"` → `""` falls through to inherit branch; same observable result |
|  475 | ConditionalExpression| default-case is an unreachable exhaustiveness guard (closed `SessionOutcome` union) |
|  475 | BlockStatement       | same — default block never executes |
|  477 | StringLiteral        | error message is built only inside that unreachable default branch |

## Reproducing

```sh
bun run mutate -- --mutate "src/session/session.ts"
```

Report: `stryker/reports/mutation/mutation.html`.
