# Scratchpad Field

> Optional `_scratchpad` field at position 1 of `CommandResponseSchema`. A forced planning slot generated **before** any other field so non-reasoning models think before committing to `type` / `content` / `risk_level`. Visible in `--log` and `--verbose`, never shown to the user.

> **Status:** Implemented.

---

## Why it exists

Wrap had no place for the model to think. Every existing field was either action-bearing or user-facing, and two failure modes recurred:

1. **Self-contradicting responses.** Haiku 4.5 once emitted an overengineered awk pipeline as `content`, then wrote *"Actually, that's overengineered. Simpler approach: ..."* in `explanation`. The critique never made it into the action because there was nowhere to plan before committing, and `explanation` got abused as a scratchpad.
2. **No `--log` visibility into reasoning.** Logs showed what the model picked, not why. When a response was wrong you had to guess whether the model was confused, hedging, or mis-selected the type.

Non-reasoning models (Haiku 4.5) also don't get extended-thinking blocks, so a scratchpad generated *before* the rest of the schema gives them a token-stream slot to plan in — analogous in shape, not power, to native reasoning.

3. **Decision quality on smaller models.** Non-reasoning models like Haiku 4.5 don't get extended-thinking blocks. A scratchpad generated *before* the rest of the schema gives them a token-stream slot to plan in — analogous in shape (not power) to native reasoning. Most relevant to type selection (`command` vs `reply`, `final` flag) and to catching their own mistakes mid-generation.

All three motivations point to the same design constraints: the field must be **first**, must be **filled when non-trivial**, and should be **brief**.

---

## Load-bearing design choices

### First-position is the entire point

Structured output is generated token-by-token in JSON-key order. Anthropic tool-use and OpenAI strict mode both honor JSON Schema property order, which derives from Zod insertion order. A scratchpad after `content` is dead weight — the model has already committed. A build-time test (`tests/schema-order.test.ts`) pins `_scratchpad` as key 0 of `CommandResponseJsonSchema`.

  type: z.enum([
    // command = ...
    "command",
    // reply = terminal text answer
    "reply",
  ]),
  final: z.boolean(), // true = terminal, false = intermediate step

### Forward-phrased rule, not a `risk_level` reference

The natural phrasing — *"required when `risk_level` is medium or high"* — has a chicken-and-egg problem. `_scratchpad` is generated before `risk_level`; at the moment the model writes scratchpad, `risk_level` doesn't exist in the output stream yet. The rule is instead phrased in terms of *intent*: "required for any request that modifies, deletes, or destroys state." The post-parse retry below is the safety net when the model mis-judges.

### Symmetric comments with `explanation`

| Field | User-facing? | Use for thinking? |
|---|---|---|
| `_scratchpad` | No | Yes |
| `explanation` | Yes | No |

The comments read as a single design statement and resist drift as the schema grows.

### Round-trace handling: strip in cross-round echoes, preserve in in-round retries

`stringifyWithoutScratchpad` drops `_scratchpad` when echoing prior-round assistant messages back to the LLM — each round plans fresh, and replaying stale plans encourages anchoring. The two in-round retry sites (`probeRiskRetry`, `scratchpadRequiredRetry`) are the deliberate exceptions: they must echo the response **with** `_scratchpad` intact so the model sees what it just wrote.

### High-risk retry: `high` only, accept-still-null

After parse, if `type === "command" && risk_level === "high" && _scratchpad == null`, `runRound` issues one in-round retry via the same mechanism as the probe-risk retry, appending `scratchpadRequiredInstruction`. Does not consume a `maxRounds` slot.

- **Why `high` only, not medium.** Medium covers mundane state changes (`mkdir`, `git add`, `chmod 644`) where forced reasoning is noise. High is reserved for destructive/irreversible commands (`rm -rf`, `git push --force`, `dd`) — exactly the cases motivating visible reasoning.
- **Why accept a still-null second response.** Retry-storming is worse than a rare log gap. The confirm panel is the final safety layer, and both null blocks remain grep-able in the log.
- **Why the instruction is narrow.** It tells the model to re-emit the same response with scratchpad filled; it does *not* encourage rewriting the command. Trading one bug class (silent dangerous commands) for another (over-revision storms) is a bad bargain.

### Reasoning models: no special handling

Always on for every provider. A per-provider flag would add config surface and schema-builder complexity to save ~$0.015/call on Opus. Reasoning models think in `<thinking>` blocks before generating structured output, so `_scratchpad` becomes a brief restatement — wasted but harmless.

### Eval integration: loose on purpose

No `scratchpad_pattern` assertion in `eval/dspy/metric.py`, no scratchpad strings in `eval/examples/seed.jsonl`. Locking MIPRO into specific reasoning shapes before we know what good reasoning looks like would constrain the optimizer prematurely. Revisit after production data accumulates.

### Log cost

Scratchpad adds ~90–310 bytes per round to `~/.wrap/logs/wrap.jsonl` (~5–15% per-entry bloat). No retention pruning lands yet (see `specs/logging.md`), so logs grow proportionally faster. Acceptable; revisit when log retention lands.

---

## Out of scope

| Decision | Choice | Rationale |
|---|---|---|
| **Field name** | `_scratchpad` | Underscore prefix conventionally signals "internal, not user-facing." `_thinking` and `_reasoning` collide with extended-thinking/reasoning-model terminology. `_plan` is too narrow. |
| **Position** | First field in `CommandResponseSchema` | Structured-output generation is linear, top to bottom. A scratchpad after `content` is dead weight — the model already committed. First-position is the entire point. |
| **Optionality** | `.nullable().optional()` | Trivial requests (`w ls`) skip it. OpenAI strict mode requires every property to appear in `required`, so `.nullable()` is necessary for the model to legally emit `null` when omitting. |
| **When to fill** | Skip if trivial (model judges); required for any non-trivial request, including anything that modifies, deletes, or destroys state | Kept the scope rule out of the schema and inside the field comment so the model can apply it forward at generation time. |
| **Risk gating (schema)** | None at schema level | See "Why no `risk_level` reference" below. |
| **Risk gating (post-parse)** | After parsing, if `type === "command"` and `risk_level === "high"` and `_scratchpad == null`, retry once with a constant instruction appended (mirrors the existing non-final-step risk retry pattern). Does not consume a round. | Closes the motivation #1 loop: every destructive command carries visible reasoning in the log. The chicken-and-egg only blocks doing this *during* generation; checking after parse is fine. See **Required scratchpad on high-risk commands** below. |
| **Length cap** | Soft cap, prompt only — "1–3 sentences" in the field comment | Hard caps via `.max(N)` would trigger validation retries when the model misjudges length, costing more than they save. No runtime check ships with v1. |
| **Visibility — `--log`** | Always (rides along inside `Round.parsed`) | The whole point of (2) above. No log schema change needed — `_scratchpad` flows through `JSON.stringify(parsed)` automatically. **Cost note:** scratchpad text adds ~90–310 bytes per round to `~/.wrap/logs/wrap.jsonl` (a ~5–15% per-entry bloat for typical entries). With no retention pruning yet (see `specs/logging.md` `expires`/pruning TODO), logs grow proportionally faster. Acceptable for v1; revisit when log retention lands. |
| **Visibility — `--verbose`** | Yes — printed via the existing `verbose()` helper, single line, newlines collapsed inline | Power-user debug aid. Format below. |
| **Visibility — confirm panel** | No | Confirmation panel reads `command + riskLevel + explanation` only. Scratchpad is for the model and the operator, not the end user being asked to confirm. |
| **Visibility — default chrome** | No | Wrap chrome stays uncluttered. Anyone who wants to see scratchpad uses `--verbose` or `--log`. |
| **Reasoning model handling** | No special handling. No config flag. Always included on every provider/model. | A flag (per-provider or global) would add config surface and schema-builder complexity to save ~$0.015/call on Opus. Reasoning models think in `<thinking>` blocks before generating structured output, so `_scratchpad` becomes a brief restatement — wasted but harmless. Not worth the complexity. |
| **Round-trace handling** | **Strip** `_scratchpad` from prior-round assistant messages before sending back to the LLM in subsequent rounds | Each round plans fresh. Keeps multi-round context windows lean. Scratchpad is intra-round reasoning; the model doesn't need to re-read its own past plans. |
| **Eval / metric integration** | Debug only — no `scratchpad_pattern` assertion in `eval/dspy/metric.py`, no scratchpad strings in `eval/examples/seed.jsonl` | Ship loose. Locking MIPRO into specific reasoning shapes before we know what good reasoning looks like would constrain the optimizer prematurely. Revisit after a few weeks of production data. |
| **`explanation` field** | Kept. Comment updated to make user-facing nature explicit and forbid thinking | See schema above. |

---

## Notes on field ordering

The two subtleties below depend on the same mechanism (linear, key-order generation of structured output) and aren't fully captured by the Decisions table.

### Why the field must be first

Structured output is generated token-by-token, in JSON-key order. Anthropic's tool-use API and OpenAI's strict mode both honor JSON Schema property order, which derives from Zod object key insertion order. So when the model emits the response object, it physically writes `_scratchpad` first, then `type`, then everything else.

If `_scratchpad` were positioned after `content`, the model would have already committed to a command before "thinking" — making the field a post-hoc rationalization slot, not a planning slot. First-position is the only configuration that gives non-reasoning models like Haiku 4.5 a chain-of-thought slot through the schema.

### Why no `risk_level` reference in the rule

The natural phrasing — *"scratchpad required when `risk_level` is medium or high"* — has a chicken-and-egg problem. `_scratchpad` is generated **before** `risk_level`. At the moment the model writes scratchpad, `risk_level` literally does not exist yet in the output stream. A rule that references it can't be enforced from the model's side.

Resolution: phrase the rule **forward**, in terms of the model's *intent*, not a downstream field. *"Required for any request that modifies, deletes, or destroys files or state"* gets the same coverage as a `risk_level`-based rule, but is something the model can self-apply at the moment scratchpad is being generated. The post-parse retry described below in **Required scratchpad on high-risk commands** is the safety net for cases where the model gets it wrong anyway.

---

## Required scratchpad on high-risk commands

The forward-phrased rule in the schema comment relies on the model judging "non-trivial" correctly. If the model judges *"awk pipeline to reformat text"* as low-risk and skips scratchpad on what turns out to be a destructive command, motivation #1 fails — back to the original trainwreck pattern. The post-parse retry below is the safety net.

### The rule

After successful parse, **before** executing the response or showing the confirm panel:

```
if response.type === "command"
   and response.risk_level === "high"
   and response._scratchpad == null:
   → retry once via the existing in-round retry mechanism
```

This is a **single in-round retry**, not a new round. It uses the same machinery as the existing in-round non-final-step risk retry: append the failed response as an `assistant` turn, append a constant instruction as the `user` turn, call the LLM again, replace the response. Does not consume a slot from `maxRounds`.

### The constant

Add to `src/prompt.constants.json`:

```json
"scratchpadRequiredInstruction": "High-risk commands require a non-null `_scratchpad` (1-3 sentences) explaining what the command does and why this approach. Re-emit the same response with `_scratchpad` filled. Do not change other fields unless your reasoning reveals a problem with the command."
```

The instruction is intentionally narrow: re-emit the same response, just fill the missing field. Do not encourage the model to second-guess the command itself — that would trade one bug class (silent dangerous commands) for another (over-revision storms).

### The code path

The check runs immediately after the existing in-round non-final-step risk retry, on the same kind of in-round retry helper. Procedure: append the parsed response as an `assistant` turn, append `scratchpadRequiredInstruction` as a `user` turn, call the LLM once more, replace the response.

This site **does not strip `_scratchpad` from the assistant turn.** The whole point is to show the model that `_scratchpad` came back `null` so it knows what to fix.

### Why high only, not medium

`risk_level === "medium"` covers a lot of mundane state changes (`mkdir`, `git add`, `chmod 644 file`) where forced reasoning would be noise. `high` is reserved for destructive/irreversible commands (`rm -rf`, `git push --force`, `dd`) — exactly the cases where motivation #1 demands visible reasoning. Tightening the gate to `high` keeps the retry rare without losing safety coverage.

### Failure mode after retry

If the retry comes back with `_scratchpad` still `null`, **accept it and continue**. Do not retry-storm. Log a warning to the structured log entry (e.g. a `Round.scratchpad_retry` field, or simply rely on the fact that two `parsed` blocks with `_scratchpad: null` and `risk_level: "high"` will be visible in the log and grep-able). The high-risk command also goes through the confirm panel, which is the existing safety layer.

---

## Verbose output format

Scratchpad routes through the existing `verbose()` helper in `src/core/verbose.ts`, which prefixes every line with `» [+0.01s] ` (dim) and outputs to stderr. Single line per response. Newlines inside the scratchpad string are collapsed to ` \n ` (literal backslash-n, with surrounding spaces for readability) so each scratchpad is one verbose line.

Example:

```
» [+1.42s] _scratchpad: Need to fetch git log first, then format as markdown table next round.
» [+1.43s] LLM responded (step, low): git log --since='1 week ago' --pretty='%ad %s' --date=short
```

If the model changed its mind mid-thought:

```
» [+0.01s] _scratchpad: I want to use awk to format the table... actually that's overengineered \n I will probe for raw data and answer with a markdown table next round.
```

When `_scratchpad` is null/missing (trivial requests), no verbose line is printed for it. The "LLM responded" line stays as today.

---

## Test plan

### Unit / parser tests (`tests/`)

1. **Parser accepts a response with `_scratchpad`.** Round-trip a valid `CommandResponse` that includes a non-null scratchpad through `parse-response.ts`; assert it parses and the field is preserved.
2. **Parser accepts a response without `_scratchpad`.** Same, with the field omitted entirely. Asserts backward compatibility — existing log entries and any minimal model response still parse.
3. **Parser accepts `_scratchpad: null`.** OpenAI strict mode coerces optional fields into nullable; the model will emit literal `null` when skipping. Confirm the parser handles it.
4. **Verbose mode prints scratchpad when present.** Capture `process.stderr.write` (the established pattern in `tests/verbose.test.ts`), run a query with a scratchpad-bearing response, and assert the verbose line appears with the expected prefix and inlined newlines.
5. **Verbose mode prints nothing for null scratchpad.** Same setup, but with `_scratchpad: null` — assert no extra verbose line is emitted.
6. **Round-trace stripping.** Simulate a probe round followed by a second round. Assert the assistant message in the second round's `messages` array does **not** contain `_scratchpad`, while the corresponding entry in the log does.
7. **`schemaText` divergence guard.** Read `src/command-response.schema.ts` between `SCHEMA_START`/`SCHEMA_END` and assert it equals `prompt.optimized.json` `schemaText` (after trim). Catches the entire class of editing-prompts-skill drift bugs (schema source updated but the runtime mirror not). ~10 lines, runs every `bun run check`.
8. **High-risk retry triggers when scratchpad is null.** Use the test provider to return a `command`/`risk_level: "high"`/`_scratchpad: null` response. Assert the LLM is called twice (the original + one retry), the second call's `messages` ends with `scratchpadRequiredInstruction`, and the round count consumed is **one**, not two.
9. **High-risk retry does not trigger when scratchpad is present.** Same setup but `_scratchpad: "destructive: rm -rf node_modules to clean install"`. Assert the LLM is called exactly once and execution proceeds normally.
10. **High-risk retry does not trigger for medium risk.** `risk_level: "medium"`, `_scratchpad: null`. Assert no retry, single call.
11. **High-risk retry accepts a still-null second response.** Both calls return `_scratchpad: null`. Assert no third call, the response is accepted, and execution continues to the confirm panel as normal.

### Field-order sanity test (required)

Confirm that `_scratchpad` is the first property in the JSON Schema derived from `CommandResponseSchema`. The schema already exports `CommandResponseJsonSchema` — use it directly:

```ts
test("_scratchpad is the first key of CommandResponseSchema", () => {
  const props = (CommandResponseJsonSchema as { properties: Record<string, unknown> }).properties;
  expect(Object.keys(props)[0]).toBe("_scratchpad");
});
```

This catches Zod upgrades that reorder keys, accidental refactors that put a new field above `_scratchpad`, and any normalization step in the SDK chain that rebuilds the JSON object. Cheap (microseconds), deterministic, runs every `bun run check`.

#### Failure mode if field-order is silently violated

The failure is **silent degradation**, not a crash. Scratchpad still parses, still appears in logs, still prints in verbose. There is no runtime error. What you lose is the planning property: a model that emits `_scratchpad` *after* `content` is writing post-hoc rationalization, not a plan — exactly the bug the spec was introduced to fix, now disguised as a successful response.

Detection at runtime is not automatic. The build-time test above catches everything inside the Wrap → ai-sdk → SDK boundary. Provider-side reordering (Anthropic's tool-use runtime, OpenAI's strict mode runtime) is vendor behavior and cannot be confirmed from code; if a provider ever reorders, the only signals would be (a) eval score regression on that provider, or (b) a manual log inspection noticing scratchpad content correlating too closely with the command instead of preceding it. Document this assumption in the test file so the next person debugging weird quality on a new provider knows where to look.

### Eval / regression

No eval changes required for v1. After landing, watch `~/.wrap/logs/wrap.jsonl` for a few days to see what scratchpad content the models actually produce. Add `scratchpad_pattern` assertions to `metric.py` later only if specific reasoning failures emerge.

---

## Out of Scope

Deliberately deferred from v1 but worth knowing about:

1. **Length-cap drift detection.** No runtime check ships with v1. If the model regularly blows past 3 sentences in production logs, add a `chars > N` warning at parse time. Don't reject — just log so we notice the trend.
2. **Eval signal upgrade.** If specific reasoning failures emerge in production, add `scratchpad_pattern` assertions to `eval/dspy/metric.py` (low weight, ~0.5) to start training MIPRO on observed failure patterns.
3. **Tightening the high-risk retry to medium.** v1 only retries on `risk_level === "high"`. If observed logs show the model also skipping scratchpad on dangerous medium-risk commands (e.g. `git push --force-with-lease`, `chmod` on system files), broaden the retry trigger to `risk_level !== "low"`.
