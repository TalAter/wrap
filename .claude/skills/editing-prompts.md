---
description: How to edit Wrap's LLM prompt without breaking the optimizer round-trip
---

# Editing Prompts

Wrap's LLM prompt is split across several files. Editing the wrong one silently breaks runtime, the next optimize run, or both. Read this before touching any prompt text.

## Where each piece lives

| Piece | File | Edit directly? |
|---|---|---|
| **Instruction text** (the behavioral rules the LLM sees) | `src/prompt.optimized.json` `instruction` field | Yes — hand-edit for immediate use. The next `bun run optimize` (GEPA) will evolve a new instruction from scratch, so hand-edits are temporary. |
| **Schema with comments** (the Zod schema text the LLM sees) | `src/command-response.schema.ts` between `// SCHEMA_START` and `// SCHEMA_END` | Yes — DSPy reads it via `read_schema.py`; the next optimize run regenerates `schemaText` in `prompt.optimized.json` from this source |
| **Constant sections** (section headers, voice instructions, last-round instruction, retry instructions, etc.) | `src/prompt.constants.json` | Yes — single source of truth |
| **Prompt hash** | `src/prompt.optimized.json` `promptHash` | **No.** Leave it stale when you edit the instruction. The next `bun run optimize` recomputes it. |

## The instruction text

GEPA is an instruction-only optimizer — it evolves the instruction from scratch via reflective mutation. There is no seed instruction to keep in sync (unlike the old MIPROv2 setup where the WrapSignature docstring was the canonical source).

**When you change the instruction:**

1. Edit `src/prompt.optimized.json` `instruction` field. Runtime picks it up immediately.
2. **Do NOT recompute `promptHash`.** It will be regenerated on the next optimize run. A stale hash between runs is fine and expected.
3. Know that `bun run optimize` will replace your edit with GEPA's output. If your change is important, encode the intent as eval examples in `eval/examples/seed.jsonl` with assertions so GEPA optimizes toward it.

## Common mistakes

- **Recomputing `promptHash`.** Pointless — it will be overwritten anyway. Skip it.
- **Editing `schemaText` in `prompt.optimized.json` directly.** It's a mirror of `command-response.schema.ts` between the SCHEMA markers. Edit the source; the optimizer regenerates the mirror. (For an immediate-use hand-edit, you may mirror it manually, but the source must also be updated or the next optimize wipes the mirror.)
- **Hand-editing `fewShotExamples`.** Always `[]`. GEPA is instruction-only and does not produce few-shot demos.

## Sanity check after editing

- `bun test tests/prompt.test.ts` — confirms `prompt.optimized.json` parses and prompt assembly works
- `bun run check` — full lint + test pass
