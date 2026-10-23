# Wrap

Wrap turns a natural-language prompt into a shell command, confirms it when
it carries risk, and runs it.

## Language

**Invocation**: One `wrap` run, from argv to exit code. Produces one log entry
unless a subcommand short-circuits.

**Session**: The runtime loop of one invocation: reducer, coordinator, dialog
lifecycle and notification routing.

**Loop**: One run of the round loop over a budget of rounds. A follow-up,
confirmed step or continuation starts a new loop with a fresh budget.

**Round**: One model response and its optional execution. A round may hold
several **attempts** (physical model calls): the parse retry and the
scratchpad retry.

**Turn**: One semantic entry of the transcript: `user`, `assistant`, `step`,
`probe` or `final`. The transcript and the log entry's `turns` are the same
list. Turns are stored bare and framed into provider messages as they are
added.

**Transient**: A conversation add consumed by the send it precedes and never
replayed (temp-dir listing, last-round instruction, retry echo).

**Echo projection**: The reduced form of a prior response the model sees on
later rounds: `type`, `final`, `content`, `risk_level`, `plan`.

**Response**: The model's structured reply. `command` (a shell command) or
`reply` (an answer). `final: false` marks an intermediate **step** whose
output is captured and fed back.

**Scratchpad**: Optional `_scratchpad` planning field, first in the schema,
never shown to the user. Required by prompt rule for state-changing requests.

**Risk level**: `low`, `medium` or `high`, reported by the model. Low final
commands auto-run on the initial loop; everything else opens the dialog.

**Yolo**: Every gate off: no dialog, no no-TTY block, non-final steps of any
risk run inline. Risk is still logged.

**Source**: Who authored an executed command: `model` or `user_override`
(edited in the dialog). Final turns also carry `cancelled`, `blocked`,
`exhausted` and `error`.

**Follow-up**: Refining the command from inside the dialog within one
invocation.

**Continuation**: `-c` resumes the previous conversation in a new invocation
by replaying the parent chain from the log.

**Skill**: A deterministic bundle of read-only **tasks** that runs before the
first model call. Each task emits a **probe** turn (command plus captured
output) ahead of the user turn.

**Tool watchlist**: Persisted tool names the discovery skill `which`-checks on
every run. Holds names to check, not tools known to exist.

**Memory**: Facts about the environment, each under a **scope** (an absolute
directory; `/` is global). Only scopes at or above cwd enter the prompt.

**Attached input**: Piped stdin, written to `$WRAP_TEMP_DIR/input` and
previewed to the model. Human-facing text says "piped".

**Scratch dir**: The per-invocation `$WRAP_TEMP_DIR` for downloaded or
generated artifacts. Store there, never execute from there.

**Chrome**: Wrap's own stderr narration: spinner, status lines, verbose
trace, errors. Never stdout.

**Notification bus**: The process-wide channel chrome is emitted on. The
session's **router** decides whether a notification goes to stderr, is
buffered until the dialog unmounts, or also updates the live dialog.

**Dialog**: A Ratatui surface on the stderr alternate screen: the response
dialog (confirm, edit, follow-up, compose, step progress), the wizard and the
forget checklist.

**Output slot**: The dialog area showing the last captured step output.

**Action bar**: The row of actions at the bottom of the response dialog.

**Editor handoff**: The state in which a terminal-owning external editor holds
the TTY and the dialog is unmounted.

**Subcommand**: A leading `--flag` that short-circuits the query (`--help`,
`--version`, `--log`, `--completion`, `--forget`).

**Modifier flag**: A flag stripped before dispatch that tweaks a query
(`--verbose`, `--model`, `-c`, `--yolo`). Derived from the settings registry.

**Prompt scaffold**: The per-session system text, few-shot prefix and context
block built from the embedded prompt assets.

**Prompt assets**: `constants.json` (hand-edited strings), `optimized.json`
(optimizer output) and `schema.txt` (schema source with comments).

**Test provider**: Canned playback selected by `WRAP_TEST_RESPONSE` or
`WRAP_TEST_RESPONSES`; bypasses provider resolution.

**Eval bridge**: The hidden `--eval-bridge` mode the prompt optimizer calls
to assemble or execute one request with the runtime's prompt path.

**Appearance**: Dark or light, resolved from env, config, cache or a terminal
probe. **Color level** is 0 to 3 (mono, 16, 256, truecolor).

**Wrap home**: `~/.wrap` or `$WRAP_HOME`: config, memory, watchlist, logs,
cache.
