# Glossary

**Invocation**: One `wrap` run.

**Query**: The LLM interaction loop within an invocation.

**Round**: One LLM response and its optional execution. Probes, intermediate
steps, and answers are each one round. A round may contain several
**attempts** (physical LLM calls) when a reply fails to parse or a high-risk
command arrives without a scratchpad.

**Session**: The runtime loop that owns the state machine, the dialog
lifecycle, and notification routing.

**Subcommand**: A CLI action selected by a leading flag (`--log`, `--help`).

**Modifier flag**: A flag stripped before dispatch that tweaks a query without
branching (`--verbose`, `--model`, `-c`).

**Skill**: A deterministic bundle of read-only probe commands that runs before
the first LLM call and emits **probe** turns (command + captured output).

**Tool watchlist**: Persisted tool names `which`-checked on every run.

**Memory**: Facts about the environment, each scoped to a directory; `/` is
global. Stored in `memory.json`.

**Chrome**: Wrap's own UI (spinner, status lines, dialog, errors). Always on
stderr or the terminal, never stdout.

**Dialog**: The alternate-screen Ratatui surface: confirmation, edit,
follow-up, compose, wizard, forget.

**Action bar**: The row of actions at the bottom of a dialog.

**Follow-up**: Refining a command from inside the dialog within one invocation.

**Continuation**: `-c` resumes the previous conversation in a new invocation.

**Risk level**: `low`, `medium`, or `high`, reported by the LLM. Low final
commands auto-run; others open the dialog.

**Yolo**: Every execution gate off; the LLM's risk is still logged.

**Attached input**: Piped stdin, written to `$WRAP_TEMP_DIR/input` and
previewed to the LLM.

**Answer**: A `reply` response printed to stdout instead of a command.

**Log**: One JSONL record per invocation at `$WRAP_HOME/logs/wrap.jsonl`;
optional trace sidecars under `logs/traces/`.

**Wrap home**: `~/.wrap` or `$WRAP_HOME`: config, memory, watchlist, logs, cache.
