---
description: How to edit Wrap's LLM prompt without breaking the optimizer round-trip
---

# Editing Prompts

Wrap's LLM prompt is split across several files. Editing the wrong one (or only one of a pair) silently breaks runtime, the next optimize run, or both. Read this before touching any prompt text.

## Where each piece lives

| Piece | File | Edit directly? |
|---|---|---|
| **Instruction text** (the behavioral rules paragraph the LLM sees) | `eval/dspy/optimize.py` `WrapSignature` docstring **AND** `src/prompt.optimized.json` `instruction` field | Both — see below |
| **Schema with comments** (the Zod schema text the LLM sees) | `src/command-response.schema.ts` between `// SCHEMA_START` and `// SCHEMA_END` | Yes — DSPy reads it via `read_schema.py`; the next optimize run regenerates `schemaText` in `prompt.optimized.json` from this source |
| **Constant sections** (section headers, voice instructions, last-round instruction, retry instructions, etc.) | `src/prompt.constants.json` | Yes — single source of truth |
| **Few-shot examples** | `eval/examples/seed.jsonl` (seeds) → MIPRO bootstraps into `src/prompt.optimized.json` `fewShotExamples` | Edit seeds only. Never hand-edit `fewShotExamples` — MIPRO regenerates them. |
| **Prompt hash** | `src/prompt.optimized.json` `promptHash` | **No.** Leave it stale when you edit the instruction. The next `bun run optimize` recomputes it. |

## The instruction text — the part that bites

The instruction is the only piece with **two sources of truth that must stay in sync**:

1. **`eval/dspy/optimize.py`** `WrapSignature` docstring — the **canonical source** that DSPy/MIPRO seeds optimization from. This is what the *next* `bun run optimize` will start from and evolve.
2. **`src/prompt.optimized.json`** `instruction` field — the **runtime artifact** that Wrap actually uses today. Normally produced by the optimizer; hand-edited between optimizer runs so you can test changes immediately.

**When you change the instruction:**

1. Edit `eval/dspy/optimize.py` `WrapSignature` docstring. This is the source of truth. If you skip this, the next optimize run silently reverts your change.
2. Edit `src/prompt.optimized.json` `instruction` field with the same wording. If you skip this, runtime won't see your change until someone runs `bun run optimize`.
3. **Do NOT recompute `promptHash`.** It will be regenerated on the next optimize run. A stale hash between runs is fine and expected.

The two strings should be substantively identical (same rules, same examples). They don't need to be byte-identical — `prompt.optimized.json` may use markdown bullets/bold while the Python docstring is a flat paragraph. That's the established convention.

## Common mistakes

- **Editing only `prompt.optimized.json`.** Runtime works, next optimize wipes the change. Always update the docstring too.
- **Editing only `optimize.py`.** Source of truth is correct, but runtime won't reflect the change until someone reruns optimize.
- **Recomputing `promptHash`.** Pointless — it will be overwritten anyway. Skip it.
- **Hand-editing `fewShotExamples`.** MIPRO owns these. Add/edit `eval/examples/seed.jsonl` instead and let the optimizer rebuild them.
- **Editing `schemaText` in `prompt.optimized.json` directly.** It's a mirror of `command-response.schema.ts` between the SCHEMA markers. Edit the source; the optimizer regenerates the mirror. (For an immediate-use hand-edit, you may mirror it manually, but the source must also be updated or the next optimize wipes the mirror.)

## Sanity check after editing

- `bun test tests/prompt.test.ts` — confirms `prompt.optimized.json` parses and prompt assembly works
- `bun run check` — full lint + test pass
- Eyeball-diff `optimize.py` docstring vs `prompt.optimized.json` instruction to confirm they say the same things
