# Scratchpad Field

> Optional `_scratchpad` field at position 1 of `CommandResponseSchema`. A forced planning slot generated **before** any other field so non-reasoning models think before committing to `type` / `content` / `risk_level`. Visible in `--log` and `--verbose`, never shown to the user.

> **Status:** Implemented.

---

## Why it exists

Wrap had no place for the model to think. Every existing field was either action-bearing or user-facing, and two failure modes recurred:

1. **Self-contradicting responses.** Haiku 4.5 once emitted an overengineered awk pipeline as `content`, then wrote *"Actually, that's overengineered. Simpler approach: ..."* in `explanation`. The critique never made it into the action because there was nowhere to plan before committing, and `explanation` got abused as a scratchpad.
2. **No `--log` visibility into reasoning.** Logs showed what the model picked, not why. When a response was wrong you had to guess whether the model was confused, hedging, or mis-selected the type.

Non-reasoning models (Haiku 4.5) also don't get extended-thinking blocks, so a scratchpad generated *before* the rest of the schema gives them a token-stream slot to plan in — analogous in shape, not power, to native reasoning.

These point to three constraints: **first**, **filled when non-trivial**, **brief**.

---

## Load-bearing design choices

### First-position is the entire point

Structured output is generated token-by-token in JSON-key order. Anthropic tool-use and OpenAI strict mode both honor JSON Schema property order, which derives from Zod insertion order. A scratchpad after `content` is dead weight — the model has already committed. A build-time test (`tests/schema-order.test.ts`) pins `_scratchpad` as key 0 of `CommandResponseJsonSchema`.

Failure mode if the ordering is silently violated is **not** a crash: scratchpad still parses and still logs, but the planning property is lost. Provider-side reordering (vendor runtimes) cannot be detected from code; the only signals would be eval regression or log inspection noticing scratchpad correlating too closely with the command rather than preceding it.

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

1. **Length-cap drift detection.** No runtime check. If the model regularly blows past 3 sentences in production logs, add a `chars > N` warning at parse time — log, don't reject.
2. **Eval signal upgrade.** Add `scratchpad_pattern` assertions to `metric.py` (low weight) only if specific reasoning failures emerge.
3. **Tightening the high-risk retry to medium.** If logs show the model skipping scratchpad on dangerous medium commands (`git push --force-with-lease`, `chmod` on system files), broaden to `risk_level !== "low"`.
