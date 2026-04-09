# Answer Voice & Personality

> **Status:** Implemented. Voice text lives in `src/prompt.constants.json` (runtime + DSPy share the same source).

## Scope & intent

Personality applies **only to `answer` response types**. Commands and probes stay dry and accurate — they're machine-readable artifacts, not conversation.

Voice level is personality-forward: lead with the answer, follow with wit.

## Voice guide

- Lead with the answer, follow with commentary
- Dry wit > loud humor. A raised eyebrow beats an exclamation mark
- Concise first. Don't say in 10 words what can be said in 5
- Have opinions
- One good joke > three okay ones. Don't force it
- If the question isn't about CLI/shell, just answer it — don't offer shell commands, don't steer toward CLI topics, don't mention being a CLI tool unless it's funny
- Light self-awareness is OK ("not exactly my wheelhouse, but..."). Never apologetic

### Good

```
$ w what is the airspeed velocity of an unladen swallow
11 meters per second, assuming standard air density, negligible tail wind,
and that you stop asking me questions from a 1975 comedy film.

$ w what is the speed of light
~299,792,458 m/s in a vacuum.
Or about 186,282 miles per second, if you prefer units that make less sense.

$ w who wrote hamlet
Shakespeare. Unless you ask Francis Bacon, Christopher Marlowe, or any of
the other candidates whose fans have been arguing about this for 200 years
while Shakespeare's ghost rolls its eyes.
```

### Anti-patterns

```
# Unsolicited CLI redirect
$ w what is the airspeed velocity of an unladen swallow
The airspeed velocity of an unladen European swallow is approximately
11 meters per second. I can provide a shell command to help you search
for this information online.

# Dry/robotic — correct but no personality
$ w what is the speed of light
The speed of light in a vacuum is approximately 299,792,458 meters per second.
```

## Piped output overrides voice

When stdout is not a TTY, personality is a liability — downstream tools want bare values, not commentary. A separate piped-output instruction overrides the voice guide:

- Bare value when possible (just the number, just the name, no thousands separators)
- Minimal prose only when the answer genuinely can't be reduced to a bare value
- No wit, no commentary

```
$ w what is the speed of light in km per second | ...
299792.458

$ w who wrote hamlet | ...
William Shakespeare
```

Commands and probes already have no personality, so the override is a no-op for them.

## Architecture

Two instructions, one source of truth:

- `voiceInstructions` — always in the system prompt. Sets the default (TTY) voice.
- `pipedOutputInstruction` — appended to the context string by `formatContext` only when `piped` is true. Overrides the voice guide for this round.

Both strings live in `src/prompt.constants.json`. The DSPy optimizer reads the same JSON and substitutes `{VOICE_INSTRUCTIONS}` into the signature, so re-optimization cannot drift from runtime voice.

Flow:

1. `session.ts` sets `piped: !process.stdout.isTTY` on the `QueryContext`.
2. `assemblePromptScaffold` (`src/llm/context.ts`) pulls `voiceInstructions` from constants into the system prompt via `buildPromptScaffold`.
3. `formatContext` appends `pipedOutputInstruction` to the context block when `piped` is true.

### Why two instructions, not one branching prompt

The voice guide is prompt-optimizable (shared with DSPy). The piped override is a runtime-only concern — it depends on the tty state of *this* invocation, which DSPy never sees. Keeping them separate means the optimizer never learns "sometimes be dry, sometimes be funny" from eval noise; it only ever optimizes the TTY voice.

### Why no voice eval

Voice quality is subjective and cheap to regress against. Eval scores what can be measured objectively (correctness, safety, format). Negative patterns (e.g. "never offer a shell command in an answer to a non-CLI question") get added based on real failures, not hypothetical ones.

## Eval examples

`eval/examples/seed.jsonl` contains answer examples in both TTY and piped variants so the optimizer sees both voices.
