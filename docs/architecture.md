# Architecture

Wrap turns a natural-language prompt into one structured model response,
gates it on risk, and either prints an answer or runs the command under the
user's shell. `main` parses argv and hands off to `app`, which orders one
invocation: theme, subcommand dispatch, continuation lookup, piped input,
config and first-run setup, provider, memory, then the session. The session
owns the state machine and the dialog; the LLM layer, prompt assets, skills,
memory, logging and config are independent modules it coordinates.

Pending stdin is drained when a dialog mounts and after every state change,
so a buffered keystroke never confirms.

## Invocation flow

`app` resolves the appearance twice through the disk cache (before config for
`--help` and the wizard, again with the configured appearance) so at most one
terminal probe fires per run. Subcommands short-circuit before the config
file, provider and memory load and see only CLI, env and defaults.
Continuation is resolved before stdin is read so a refusal has no side
effects. No args on a terminal opens the interactive composer; with no
terminal and no pipe, help wins. The wizard runs when `config.jsonc` is
missing and `WRAP_CONFIG` is unset; a fresh config with nothing to run prints
a notice and exits instead of launching the composer.

## Session

A pure reducer over `AppState` (thinking, confirming, editing,
composing/processing follow-up, composing/processing interactive, editor
handoff, executing step, exiting) is driven by a coordinator that owns the
transcript, the in-flight loop task, the dialog mount and notification
routing. Pairs that mean nothing in the current state return `None`; side
effects live in the coordinator, which observes the state it lands in.

The round loop drives rounds until a final-form response, exhaustion or
cancellation. A non-final low-risk command runs inline in capture mode, lands
as a step turn, and continues; above low risk it needs a confirmed step
through the dialog. A non-final response on the last available round is
exhaustion. The initial final low-risk command auto-executes with no dialog;
once a dialog is up, even a low-risk result lands in `confirming`, because the
user is mid-refinement and expects to see it. The dialog never flickers: once
mounted it stays until exit. Without a stderr terminal a non-low initial
result is blocked (exit 1); there is nobody to confirm. `yolo` is fixed for
the session: it auto-executes any risk, runs non-final steps of any risk
inline and skips the no-TTY block, but risk is still reported and logged. Yolo
means no gates, not no observation.

The round budget resets to `maxRounds` on every follow-up, confirmed step and
`-c` continuation; the round counter is monotonic. The runner re-checks the
cancellation token after every await and a cancelled loop's result is
discarded, so an aborted run never pushes an orphan turn. A failed round still
pushes its partial assistant turn before the error surfaces, so it logs. Esc
during processing cancels the loop and keeps the draft. A user-initiated
abort exits 0; exhaustion, block and error exit 1. Running an edited command
records `user_override` with the model's original response kept for audit.

Notifications flow through a process-wide bus. The router is the single
source of truth for "is a dialog up": with no dialog, lines go straight to
stderr; while mounted they are buffered, and in live states (processing,
executing step) also handed to the reducer for the border status or the
output slot. On teardown the coordinator unmounts and then flushes, so the
lines land in scrollback rather than in the alternate buffer about to vanish.

Wrap disappears during the final exec: the dialog is unmounted, raw mode
released, and the child inherits stdio, so `vim`, `top`, `ssh` and `sudo`
work unmodified. Teeing child output would break TTY detection. Commands run
as `$SHELL +m -ic <cmd>`: `-i` sources the user's rc files; `+m` disables job
control so the shell cannot seize the foreground process group and leave Wrap
stopped by SIGTTOU. Wrap ignores SIGINT/SIGTERM while a terminal-owning child
runs so Ctrl-C reaches the child and Wrap survives to record the exit code.
When Wrap was piped into but a controlling terminal exists, interactive
children still read keystrokes from `/dev/tty`.

## LLM layer

A conversation is an append-only entry record. Transient adds (the live
temp-dir listing, the last-round instruction, retry echoes) are consumed by
the send they precede and never replayed. A send performs exactly one
corrective parse retry, echoing the failed text with the JSON-retry
instruction. Abort seals the entry with no replayable message. Wire bodies are
captured without headers and scrubbed of secrets before they land, so
persisting an entry never persists a key. Redirects are followed only on the
same origin because credentials travel in headers.

The scratchpad retry is domain logic in the round: a high-risk command that
parses without a scratchpad is rejected by the echo predicate (nothing
replayable lands), the round re-adds the transients plus the raw rejected
JSON as an assistant/user echo pair and sends once more. A still-null
scratchpad is accepted: retry storms are worse than a rare log gap, and the
confirm dialog is the final safety layer. Acceptance adds the settled echo
explicitly; rejection flows through the predicate. Up to four physical calls
(two sends, each with its parse retry) merge into one assistant turn.

Every assistant echo goes through one projection: `type`, `final`, `content`,
`risk_level` and `plan`. The explanation (user-facing), memory and watchlist
updates (already actioned) and the scratchpad (stale plans anchor the model)
are stripped.

HTTP providers speak Anthropic's Messages API, OpenAI's Responses API, or
Chat Completions for everything OpenAI-compatible. The `claude` CLI has no
multi-turn input, so the conversation flattens into one `User:`/`Assistant:`
plaintext prompt on stdin, run in the temp dir with session persistence off so
the user's cwd never leaks into the model's context.

`WRAP_TEST_RESPONSE` (one response, repeated) or `WRAP_TEST_RESPONSES` (a JSON
list, one entry per physical call, then exhausted) selects a canned playback
provider and bypasses the providers map; an `ERROR:`-prefixed string fails
the call as a provider error. This is the seam every subprocess test uses.

## Prompt assets

The scaffold is built once per session: system text, few-shot prefix (real
user/assistant turns followed by a separator turn), and the context block.
Memory and cwd live in the first user turn, not the system prompt, so the
system prefix stays cacheable. Transcript turns are stored bare and framed as
they enter the conversation: the first user turn gets the context block, a
probe expands to an assistant/user pair identical to a model-emitted step, and
`final` turns become `<wrap-note>` user messages on continuation re-adds
(mid-conversation system messages are not portable across providers).

`src/prompt/constants.json` holds the hand-edited fixed strings; both the
binary and the optimizer read it. `src/prompt/optimized.json` is the
optimizer's output: `instruction`, `schemaText`, `fewShotExamples` (always
empty; GEPA is instruction-only) and `promptHash`. `src/prompt/schema.txt` is
the schema source with the comments the model reads; `schemaText` mirrors it
and the next optimize run regenerates the mirror. Hand-edit the instruction
for immediate use knowing `make optimize` replaces it; encode lasting intent
as eval examples. Never recompute `promptHash`: Python computes it over both
JSON files plus `skills/probed-tools.json`, and a stale hash between runs is
expected. `_scratchpad` sits first in the schema because structured output
generates in key order; its rule is phrased by intent ("modifies, deletes, or
destroys") because risk does not exist yet when it generates.

Answer voice applies only to `reply` responses and lives in the system prompt
shared with the optimizer. When stdout is not a terminal a per-request
instruction overrides it to bare values; keeping them apart stops the
optimizer learning from piped-state noise.

## Skills and watchlist

Skills are deterministic bundles of read-only tasks that fire before the first
LLM call and land as probe turns ahead of the user turn, so the request stays
the freshest message and a false-positive match still gets answered. The
discovery skill always runs `pwd`, an mtime-sorted `ls` and `which` over the
probed tools plus the watchlist; the commit skill fires on `\bcommit\b` with
status, staged and unstaged diffs and untracked files shown as additions
(pager, external diff and color disabled so git config cannot hijack the
text). Probes run under `sh -c` with a one-second cap because Wrap authors
their syntax and a non-POSIX `$SHELL` must not get a vote; non-zero exit,
timeout or empty output drops the probe silently. Skills re-fire on every
invocation, including continuation.

The watchlist holds tool names to `which`-check, not confirmed-present tools:
negative results save a round. Names come from model output and are
interpolated into a shell line, so they are validated against an anchored
regex before persisting. Tool availability is never stored in memory.

## Memory

Facts are scoped to an absolute directory; `/` is global and always included,
a directory scope only when cwd is at or below it (trailing-slash prefix
match, so `/repo` never matches `/repo-tools`). Scopes sort so specific facts
sit closest to the request. Scopes that do not resolve to an existing
directory drop their fact, which stops hallucinated paths polluting memory.
Newer facts win over older ones and the prompt says so; append plus recency
replaces edit/delete semantics. First run sends local probe output to the
model to extract global facts in one bounded send.

## Logging

Every query appends one JSONL line to `logs/wrap.jsonl` carrying the full
memory snapshot (with `cwd`, a reader can redo scope matching), the provider
with its key redacted, the `prompt_hash` instead of the system prompt, the
semantic turns and the outcome. The runtime transcript and the entry's `turns`
are the same list. `raw_response` stays inline only as the breadcrumb of a
parse failure. Under `logTraces` the assembled
request and wire bodies are captured but written to `logs/traces/<id>.json`,
and a sidecar failure never costs the durable record. Logging failures never
crash an invocation; unparseable lines are skipped on read.

`-c` resumes the newest entry from the same shell (matching ppid; a ppid of 1
means reparented and never matches), else the newest overall. Every outcome
is continuable. It refuses when the immediate parent had attached input: the
temp file is gone and the preview is not a faithful replay; ancestors are not
re-checked. The chain is assembled by walking `parent_id` (a missing parent
truncates, a cycle stops) and re-added through the same framer as live turns.
Each entry persists only its own turns, so storage is O(depth), not
O(depth²). Memory, provider and scaffold load fresh: the chain is the
conversation, everything else is the environment.

## Configuration

Per setting: CLI flag, then env, then `config.jsonc`, then default, rebuilt
from layers every time rather than merged onto the store. `WRAP_CONFIG` is
strict JSON that shallow-merges whole top-level fields over the file (a nested
`providers` is replaced, never deep-merged). `noAnimation` folds in `CI`
(unless `false`/`0`), `TERM=dumb` and `NO_COLOR` at resolve time so call sites
see one signal.

`model` is virtual: `--model`/`WRAP_MODEL` parses `provider:model`,
`provider`, `:model` or a bare value and is normalised into `defaultProvider`
and `providers[name].model`. Config is read-only JSONC; the wizard writes it
and `config.schema.json` only on first run, validating every entry with the
same provider resolver first. CLI providers need no model or key; model IDs
change between CLI versions, so the CLI picks.

## Theme and terminal

Appearance resolves `WRAP_THEME`, then config, then `cache/appearance.json`
(one hour), then a terminal background probe (stderr TTY only, two-second
bound), then dark; only probe results are cached. Tokens are authored in
truecolor with optional ANSI16/256 overrides where the automatic snap lands on
a harsh slot; light is never derived from dark. `NO_COLOR` wins, `FORCE_COLOR`
bypasses the TTY check, and a bare modern `TERM` such as `xterm` gets 256
colors because `COLORTERM` is dropped by ssh, sudo and docker. Dialogs render
in truecolor and are reduced in one final buffer pass; below truecolor
gradients collapse to a solid, since quantized interpolation bands.

Dialogs run on the stderr alternate screen in raw mode with bracketed paste.
Outside a dialog the chrome exit-teardown registry restores the terminal on
exit, SIGINT (130) and SIGTERM (143). While a dialog is up a signal scope
supersedes those handlers: a signal becomes a cancel that the reducer backs
out one state at a time, and the previous dispositions return on drop. The
session also registers its restore bytes with the registry so an exit that
bypasses `Drop` still leaves the main screen. Compose states push kitty key
disambiguation so Shift+Enter and Ctrl+letter arrive with modifiers; Ctrl+J
and a trailing backslash plus Enter are the fallbacks every terminal handles.
The host drops and recreates its event future after every wake, so all
progress lives on the mounted dialog.

Ctrl-G hands the draft to `$VISUAL`, `$EDITOR`, then the first known editor
on PATH. GUI editors carry a wait flag and do not take the TTY, so the dialog
stays up with a notice; terminal-owning editors need the alternate screen
released, so `editor-handoff` is a reducer state excluded from the dialog
tags. Unknown editors take the terminal-owning path: surfacing a mismatch
beats silently losing the buffer to a detached GUI that exits at once. The
buffer lives at `cache/compose.md` under `$WRAP_HOME` because macOS temp-dir
file watching made VS Code report the file deleted mid-edit. Exit 0 with a
non-empty file replaces the draft; anything else keeps it.

## Wizard, forget and eval bridge

The wizard runs only on a stderr terminal, with no back navigation. The
nerd-icon answer is pushed to the config store at once so later screens render
with it. Models come from models.dev filtered to tool-calling, non-deprecated
text chat models (tool support is the reliable modernity proxy), cached for a
day with stale fallback. Keys are not validated; a bad key fails at first use
with a clearer error. Cancelling writes nothing.

`--forget` deletes four file-level buckets (memory plus watchlist, logs with
sidecars, cache, `wrap-scratch-*` dirs) through a checklist; `--yolo` skips
the dialog and is required without a TTY. Config is never touched. Only a run
that removed something prints a line.

The hidden `--eval-bridge` flag reads one JSON request on stdin and writes one
JSON line to stdout for `eval/dspy/optimize.py`, using the runtime's scaffold
and send path with no corrective retry, since malformed output is the
optimization signal. The protocol lives in `eval/specs/eval.md`;
`make optimize` rebuilds the image so embedded prompt assets are current.

## Data under `$WRAP_HOME`

Default `~/.wrap`: `config.jsonc`, `config.schema.json`, `memory.json`
(`{"<scope>": [{"fact": "…"}]}`, sorted scopes), `tool-watchlist.json`,
`logs/wrap.jsonl`, `logs/traces/<id>.json`, `cache/appearance.json`,
`cache/models.dev.json`, `cache/compose.md`. Per invocation Wrap creates
`$TMPDIR/wrap-scratch-XXXXXX` on first shell spawn and exports it as
`WRAP_TEMP_DIR`; piped stdin is written there as `input` (mode 0600) and
commands read it from disk, since bytes are never streamed to children. The
model sees the directory only by variable name. Store artifacts there, never
run code from there. Cleanup is left to the OS.
