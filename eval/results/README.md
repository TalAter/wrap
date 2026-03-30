# Eval Results

A timestamped JSON file (e.g., `20260330-014006.json`) is written after each `bun run optimize` run. It captures everything needed to understand what the optimizer did and what failed.

## Structure

```json
{
  "timestamp": "ISO 8601 UTC",
  "models": {"teacher": "model-id", "target": "model-id"},
  "num_candidates": 15,
  "num_trials": 25,
  "winning_instruction": "The optimized system prompt instruction text",
  "winning_demos": [],
  "training_score": 0.967,
  "validation_score": 0.864,

  "trial_difficulty": [
    {
      "query": "delete all docker images",
      "cwd": "/Users/talater/project",
      "piped": false,
      "evals": 25,
      "perfect": 2,
      "avg": 0.12,
      "errors": 0
    }
  ],

  "train_results": [
    {
      "query": "delete all docker images",
      "cwd": "/Users/talater/project",
      "piped": false,
      "score": 0.6,
      "error_type": null,
      "response": {"type": "command", "content": "...", "risk_level": "...", ...},
      "assertions": {"type": "command", "risk_range": ["high"], "content_pattern": "..."}
    }
  ],

  "val_results": [...]
}
```

## How to read it

### trial_difficulty (sorted by avg score, worst first)

Aggregated across ALL instruction candidates during optimization. Answers: "which examples are hard regardless of instruction?"

- `avg` close to 0 = unsolvable by any instruction (fix the example or the model can't do it)
- `avg` around 0.5 = instruction-sensitive (good instructions handle it, bad ones don't)
- `avg` = 1.0 = always solved (omitted unless you look for it)
- `errors` > 0 = bridge/provider failures (not the instruction's fault)

### train_results / val_results (winning prompt only)

Detailed per-example results from the winning prompt evaluated on train and val sets separately. Each entry has the full LLM response and the assertions it was scored against.

- `score` < 1.0 = something didn't match. Compare `response` fields against `assertions` to see what.
- `error_type` = `"invalid_json"` | `"invalid_schema"` | `"provider_error"` | `null` (success)

### Suggested analysis prompts

Feed the JSON file + this README to an LLM and ask:

- "Which examples are hardest across all trials? What do they have in common?"
- "For the winning prompt, which examples scored below 1.0? What went wrong in each case?"
- "Are any assertions too strict? Show me cases where the response looks correct but the score is low."
- "Compare train vs val scores. Are there examples that work in training but fail in validation?"
