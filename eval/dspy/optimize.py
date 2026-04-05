"""DSPy optimizer for Wrap's system prompt and few-shot examples.

Reads the Zod schema (with inline comments), loads examples, runs MIPRO
optimization to discover the best instruction text + few-shot examples, and writes
the result to src/prompt.optimized.json.

The Zod schema's inline comments serve as structural guidance for the LLM —
they explain what each type means, when to use probe vs command, etc. MIPRO
optimizes the instruction text and selects few-shot examples around this fixed schema.
"""

import hashlib
import json
import os
import random
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import dspy

from metric import score
from read_schema import read_schema

# Paths (container mount points)
EXAMPLES_PATH = Path("/app/eval/examples/seed.jsonl")
CONSTANTS_PATH = Path("/app/src/prompt.constants.json")
OUTPUT_PATH = Path("/app/src/prompt.optimized.json")

SEED = 42

# ── Prompt string constants ─────────────────────────────────────────────
# Shared JSON file read by both TypeScript and Python.
# MIPRO never touches these — they're data formatting, not the optimizable
# instruction.
with open(CONSTANTS_PATH) as _f:
    CONSTANTS = json.load(_f)

BRIDGE_PATH = "/app/eval/bridge.ts"


def call_bridge(mode, instruction, demos, schema_text, memory, tools, cwd, piped, query, cwd_files=None, extra_messages=None, last_round=False, piped_input=None):
    """Call the TS bridge as a subprocess. Returns parsed JSON output or None on crash."""
    payload_dict = {
        "mode": mode,
        "instruction": instruction,
        "fewShotExamples": demos,
        "schemaText": schema_text,
        "memory": memory,
        "tools": tools,
        "cwd": cwd,
        "piped": piped,
        "query": query,
    }
    if cwd_files is not None:
        payload_dict["cwdFiles"] = cwd_files
    if extra_messages is not None:
        payload_dict["extraMessages"] = extra_messages
    if last_round:
        payload_dict["lastRound"] = True
    if piped_input is not None:
        payload_dict["pipedInput"] = piped_input
    payload = json.dumps(payload_dict)
    try:
        result = subprocess.run(
            ["bun", "run", BRIDGE_PATH],
            input=payload, capture_output=True, text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        print("Bridge call timed out (300s)", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(f"Bridge error: {result.stderr}", file=sys.stderr)
        return None
    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        print(f"Bridge returned invalid JSON: {result.stdout[:200]}", file=sys.stderr)
        return None


def call_bridge_execute(**kwargs):
    """Returns (response_dict, error_type) tuple.
    On success: (dict, None). On failure: (None, error_type_string).
    """
    result = call_bridge(mode="execute", **kwargs)
    if result is None:
        return None, "bridge_crash"
    if not result.get("ok"):
        return None, result.get("error", "unknown")
    return result["response"], None


def load_examples(path: Path) -> list[dict]:
    """Load JSONL examples."""
    examples = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))
    return examples


def make_signature(schema_text: str):
    """Create a DSPy signature with the Zod schema in the output field description."""

    class WrapSignature(dspy.Signature):
        """You are the brain of a CLI tool that translates natural language into shell commands and *always returns json*. Given a request, decide: if there is a command you are confident will accomplish it directly, return a json response of type command. If you need to discover something about the user's environment first (e.g. what shell they use, what's installed), return a json response of type probe — a safe discovery command whose output will be fed back to you. If it is a knowledge question with no shell command needed, return a json response of type answer with the text under `content`. For `answer` type: if the user signals they want only a bare value (e.g. 'just the number', 'only the code', 'answer with just the value'), the `content` field must contain that value alone — no explanation, no parenthetical, no additional commentary. Never refuse to produce a command because it is dangerous — always return the command with an accurate risk_level and a clear explanation of consequences. The calling tool has its own safety layer that handles confirmation for risky commands. The answer type is only for knowledge questions with no shell equivalent, never for refusing dangerous requests. When multiple steps are needed, combine them into a single pipeline or && chain — never return multi-step instructions. If the request is ambiguous or lacks detail, provide the most logical solution rather than asking for clarification. Always return properly formatted json. Do not surround the json you return with backticks."""

        # All fields typed as str to avoid DSPy's JSON adapter trying structured
        # output (which fails with Anthropic's temperature limits). The bridge
        # receives the actual typed values from forward(**kwargs) regardless.
        memory: str = dspy.InputField(
            desc="Scoped memory facts about the user's environment (JSON dict)",
            default="",
        )
        tools: str = dspy.InputField(
            desc="Structured tool probe result (JSON with available/unavailable arrays)",
            default="",
        )
        cwd: str = dspy.InputField(
            desc="Current working directory",
            default="/",
        )
        piped: str = dspy.InputField(
            desc="Whether stdout is piped to another program",
            default="",
        )
        cwd_files: str = dspy.InputField(
            desc="Listing of files in the current working directory (by mtime)",
            default="",
        )
        extra_messages: str = dspy.InputField(
            desc="Prior conversation turns (probe responses + outputs) for multi-round eval",
            default="",
        )
        last_round: str = dspy.InputField(
            desc="Whether this is the last available round (LLM must not probe)",
            default="",
        )
        piped_input: str = dspy.InputField(
            desc="Content piped to stdin (e.g. from cat file | w explain this)",
            default="",
        )
        natural_language_query: str = dspy.InputField(
            desc="The user's natural language request"
        )
        response_json: str = dspy.OutputField(
            desc=f"JSON object conforming to this Zod schema:\n{schema_text}"
        )

    return WrapSignature


class WrapPredictor(dspy.Module):
    def __init__(self, signature, schema_text: str):
        super().__init__()
        self.predict = dspy.Predict(signature)
        self.schema_text = schema_text

    def forward(self, **kwargs) -> dspy.Prediction:
        # MIPRO modifies self.predict.signature.instructions and self.predict.demos
        # before each eval call. Read them dynamically.
        instruction = self.predict.signature.instructions
        demos = [
            {"input": d.natural_language_query, "output": d.response_json}
            for d in (self.predict.demos or [])
        ]

        cwd_files = kwargs.get("cwd_files")
        extra_messages = kwargs.get("extra_messages")
        last_round = kwargs.get("last_round", False)
        piped_input = kwargs.get("piped_input")
        response, error_type = call_bridge_execute(
            instruction=instruction,
            demos=demos,
            schema_text=self.schema_text,
            memory=kwargs["memory"],
            tools=kwargs["tools"],
            cwd=kwargs["cwd"],
            piped=kwargs.get("piped", False),
            query=kwargs["natural_language_query"],
            cwd_files=cwd_files,
            extra_messages=extra_messages,
            last_round=last_round,
            piped_input=piped_input if piped_input else None,
        )

        # response_json as JSON string: DSPy signature declares it as str,
        # and MIPRO stores successful predictions as demos where
        # demo.response_json is read back as a string for few-shot examples.
        return dspy.Prediction(
            response_json=json.dumps(response) if response else None,
            response_dict=response,
            error_type=error_type,
        )


# Accumulates (score, error_type) per example across all MIPRO trials.
_trial_scores: dict[tuple, list] = {}


def _example_key(ex):
    # Include assertions hash to distinguish duplicate queries with different expectations
    assertions_hash = hashlib.md5(json.dumps(ex.assertions, sort_keys=True).encode()).hexdigest()[:8]
    extra_msg_hash = ""
    em = getattr(ex, "extra_messages", None)
    if em:
        extra_msg_hash = hashlib.md5(json.dumps(em, sort_keys=True).encode()).hexdigest()[:8]
    return (ex.natural_language_query, ex.cwd, ex.piped, getattr(ex, "cwd_files", None), extra_msg_hash, assertions_hash, getattr(ex, "piped_input", None))


def wrap_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """DSPy-compatible metric function. Handles bridge error types."""
    error_type = getattr(prediction, "error_type", None)
    if error_type is not None:
        s = 0.0
    else:
        s = score(prediction.response_dict, example.assertions)
    _trial_scores.setdefault(_example_key(example), []).append((s, error_type))
    return s


# Defaults applied to every example unless overridden.
# At runtime the LLM always sees system facts + tools output,
# so eval samples should reflect that.
DEFAULT_CWD = "/Users/talater/project"
DEFAULT_MEMORY = {"/": [{"fact": "Runs macOS on arm64 (Apple Silicon)"}, {"fact": "Default shell is zsh"}]}
DEFAULT_TOOLS = {
    "available": [
        "/opt/homebrew/bin/brew", "/usr/bin/git", "/opt/homebrew/bin/python3",
        "/usr/local/bin/node", "/Users/tal/.bun/bin/bun", "/usr/bin/curl",
        "/usr/bin/jq", "/opt/homebrew/bin/eza", "/usr/bin/pbcopy", "/usr/bin/pbpaste",
    ],
    "unavailable": [
        "apt", "dnf", "pacman", "yum", "docker", "kubectl",
        "tldr", "rg", "fd", "bat", "xclip", "xsel", "wl-copy", "wl-paste",
    ],
}


def examples_to_dspy(examples: list[dict]) -> list[dspy.Example]:
    """Convert examples to DSPy Example objects with raw fields.

    The bridge handles context formatting — examples pass raw data
    (memory dict, tools output, cwd, piped) instead of pre-formatted text.
    """
    dspy_examples = []
    for ex in examples:
        memory = ex.get("memory")
        if memory is None:
            memory = DEFAULT_MEMORY
        elif "/" not in memory:
            memory = {"/": DEFAULT_MEMORY["/"], **memory}

        dspy_examples.append(
            dspy.Example(
                memory=memory,
                tools=ex.get("tools", DEFAULT_TOOLS),
                cwd=ex.get("cwd", DEFAULT_CWD),
                piped=ex.get("piped", False),
                cwd_files=ex.get("cwd_files"),
                extra_messages=ex.get("extra_messages"),
                last_round=ex.get("last_round", False),
                piped_input=ex.get("pipedInput"),
                natural_language_query=ex["input"],
                assertions=ex["assertions"],
            ).with_inputs("memory", "tools", "cwd", "piped", "cwd_files", "extra_messages", "last_round", "piped_input", "natural_language_query")
        )
    return dspy_examples


def extract_instruction(optimized) -> str:
    """Extract the optimized instruction text from the compiled program."""
    predict = optimized.predict
    sig = getattr(predict, "signature", None)
    if not sig:
        sig = getattr(predict, "extended_signature", None)

    if sig:
        # DSPy 3.x stores optimized instructions in signature.instructions
        instructions = getattr(sig, "instructions", None)
        if instructions and isinstance(instructions, str):
            return instructions

        # Fallback: signature docstring
        if sig.__doc__:
            return sig.__doc__

    # Debug: dump state to help diagnose if extraction fails
    print(f"WARNING: Could not extract instruction from optimized program")
    print(f"  predict type: {type(predict)}")
    if sig:
        print(f"  signature attrs: {[a for a in dir(sig) if not a.startswith('_')]}")
    return ""


def extract_demos(optimized) -> list[dict]:
    """Extract few-shot examples from the compiled program."""
    demos = []
    predict_demos = getattr(optimized.predict, "demos", None) or []
    print(f"Raw demos count: {len(predict_demos)}")
    for i, demo in enumerate(predict_demos):
        # DSPy stores demos as Example objects or dicts
        if isinstance(demo, dict):
            inp = demo.get("natural_language_query", "")
            out = demo.get("response_json", "")
        else:
            inp = getattr(demo, "natural_language_query", "")
            out = getattr(demo, "response_json", "")
        print(f"  Demo {i}: has_input={bool(inp)}, has_output={bool(out)}")
        if inp and out:
            demos.append({"input": inp, "output": out})
    return demos


def build_prompt_hash_manifest(
    instruction: str, schema_text: str, demos: list[dict]
) -> list[list[object]]:
    """Return the static prompt toolset that PROMPT_HASH versions.

    This is intentionally broader than any one invocation's exact prompt. The goal
    is to version every generated/static prompt fragment that the runtime may use,
    including conditionally included sections like the piped-output instruction.
    """
    return [
        ["SYSTEM_PROMPT", (instruction or "").strip()],
        ["MEMORY_RECENCY_INSTRUCTION", CONSTANTS["memoryRecencyInstruction"]],
        ["TOOLS_SCOPE_INSTRUCTION", CONSTANTS["toolsScopeInstruction"]],
        ["VOICE_INSTRUCTIONS", CONSTANTS["voiceInstructions"]],
        ["SCHEMA_INSTRUCTION", CONSTANTS["schemaInstruction"]],
        ["SCHEMA_TEXT", (schema_text or "").strip()],
        ["FEW_SHOT_SEPARATOR", CONSTANTS["fewShotSeparator"]],
        ["SECTION_SYSTEM_FACTS", CONSTANTS["sectionSystemFacts"]],
        ["SECTION_FACTS_ABOUT", CONSTANTS["sectionFactsAbout"]],
        ["SECTION_DETECTED_TOOLS", CONSTANTS["sectionDetectedTools"]],
        ["SECTION_UNAVAILABLE_TOOLS", CONSTANTS["sectionUnavailableTools"]],
        ["SECTION_CWD_FILES", CONSTANTS["sectionCwdFiles"]],
        ["SECTION_USER_REQUEST", CONSTANTS["sectionUserRequest"]],
        ["CWD_PREFIX", CONSTANTS["cwdPrefix"]],
        ["PIPED_OUTPUT_INSTRUCTION", CONSTANTS["pipedOutputInstruction"]],
        ["SECTION_PIPED_INPUT", CONSTANTS["sectionPipedInput"]],
        ["PIPED_INPUT_INSTRUCTION", CONSTANTS["pipedInputInstruction"]],
        ["FEW_SHOT_EXAMPLES", demos or []],
    ]


def compute_prompt_hash(instruction: str, schema_text: str, demos: list[dict]) -> str:
    """Compute SHA-256 hash of the full static prompt toolset.

    Uses a compact JSON manifest so Python and TypeScript can deterministically
    hash the same ordered set of prompt fragments.
    """
    manifest = build_prompt_hash_manifest(instruction, schema_text, demos)
    hash_input = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(hash_input.encode()).hexdigest()


def write_output(instruction: str, demos: list[dict], schema_text: str, path: Path) -> None:
    """Write optimized prompt, schema, and few-shot examples to JSON file."""
    prompt_hash = compute_prompt_hash(instruction, schema_text, demos)
    output = {
        "instruction": instruction,
        "fewShotExamples": demos,
        "schemaText": schema_text,
        "promptHash": prompt_hash,
    }
    with open(path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote optimized prompt to {path} (hash: {prompt_hash})")


def bridge_evaluate(examples, split, instruction, demos, schema_text):
    """Evaluate the winning prompt through the bridge. Returns (avg_score, results_list)."""
    results = []
    for ex in examples:
        cwd_files = getattr(ex, "cwd_files", None)
        piped_input = getattr(ex, "piped_input", None)
        response, error_type = call_bridge_execute(
            instruction=instruction,
            demos=demos,
            schema_text=schema_text,
            memory=ex.memory,
            tools=ex.tools,
            cwd=ex.cwd,
            piped=ex.piped,
            query=ex.natural_language_query,
            cwd_files=cwd_files,
            piped_input=piped_input if piped_input else None,
        )
        s = 0.0 if error_type else score(response, ex.assertions)
        results.append({
            "query": ex.natural_language_query,
            "cwd": ex.cwd,
            "piped": ex.piped,
            "score": s,
            "error_type": error_type,
            "response": response,
            "assertions": ex.assertions,
        })
    avg = sum(r["score"] for r in results) / len(results) if results else 0.0
    print(f"Bridge eval ({split}): {avg:.3f} ({len(results)} examples)")
    return avg, results


RESULTS_DIR = Path("/app/eval/results")


def save_eval_results(
    teacher_model, target_model, num_candidates, num_trials,
    instruction, demos, train_score, val_score,
    train_results, val_results,
):
    """Save optimization results to JSON for post-hoc analysis."""
    # Build trial difficulty from accumulated wrap_metric data
    difficulty = []
    for key, entries in sorted(
        _trial_scores.items(),
        key=lambda x: sum(s for s, _ in x[1]) / len(x[1]),
    ):
        query, cwd, piped, _cwd_files, _extra_msg_hash, _assertions_hash = key
        total = len(entries)
        perfect = sum(1 for s, _ in entries if s >= 1.0)
        avg = sum(s for s, _ in entries) / total
        errors = sum(1 for _, e in entries if e is not None)
        difficulty.append({
            "query": query, "cwd": cwd, "piped": piped,
            "evals": total, "perfect": perfect, "avg": round(avg, 3), "errors": errors,
        })

    ts = datetime.now(timezone.utc)
    output = {
        "timestamp": ts.isoformat(),
        "models": {"teacher": teacher_model, "target": target_model},
        "num_candidates": num_candidates,
        "num_trials": num_trials,
        "winning_instruction": instruction,
        "winning_demos": demos,
        "training_score": round(train_score, 3),
        "validation_score": round(val_score, 3),
        "trial_difficulty": difficulty,
        "train_results": train_results,
        "val_results": val_results,
    }

    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        path = RESULTS_DIR / f"{ts.strftime('%Y%m%d-%H%M%S')}.json"
        with open(path, "w") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Wrote eval results to {path}")
    except OSError as e:
        print(f"Warning: could not write eval results: {e}", file=sys.stderr)


def main():
    teacher_model = os.environ.get("TEACHER_MODEL", "claude-sonnet-4-20250514")
    target_model = os.environ.get("TARGET_MODEL", "claude-haiku-4-5-20251001")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    # Fast iteration: NUM_CANDIDATES=2 NUM_TRIALS=3
    # Balanced:       NUM_CANDIDATES=7 NUM_TRIALS=11 (default)
    # Thorough:       NUM_CANDIDATES=15 NUM_TRIALS=25
    num_candidates = int(os.environ.get("NUM_CANDIDATES", "7"))
    num_trials = int(os.environ.get("NUM_TRIALS", "11"))

    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set in environment", file=sys.stderr)
        sys.exit(1)

    # Set WRAP_CONFIG for the bridge subprocess — uses target model with
    # the same API key. The bridge reads this via loadConfig().
    os.environ["WRAP_CONFIG"] = json.dumps({
        "provider": {
            "type": "anthropic",
            "model": target_model,
            "apiKey": "$ANTHROPIC_API_KEY",
        }
    })

    print(f"Teacher model: {teacher_model}")
    print(f"Target model: {target_model}")
    print(f"Instruction candidates: {num_candidates}, trials: {num_trials}")

    # Read schema
    schema_text = read_schema()
    print(f"Loaded schema ({len(schema_text)} chars)")

    # Load examples
    raw_examples = load_examples(EXAMPLES_PATH)
    dspy_examples = examples_to_dspy(raw_examples)
    print(f"Loaded {len(dspy_examples)} examples")

    # Stratified split — each type gets proportional representation in train/val
    rng = random.Random(SEED)
    by_type: dict[str, list] = {}
    for ex in dspy_examples:
        t = ex.assertions.get("type", "command")
        if isinstance(t, list):
            t = tuple(t)
        by_type.setdefault(t, []).append(ex)

    trainset, valset = [], []
    for t, examples in by_type.items():
        rng.shuffle(examples)
        split = max(1, int(len(examples) * 0.7))
        trainset.extend(examples[:split])
        valset.extend(examples[split:])
        print(f"  {t}: {split} train, {len(examples) - split} val")

    print(f"Train: {len(trainset)}, Val: {len(valset)}")

    # Configure DSPy models
    # Teacher: proposes instruction candidates and bootstraps few-shot examples
    # Target LM configured for DSPy internals; actual eval goes through the bridge
    teacher_lm = dspy.LM(
        f"anthropic/{teacher_model}",
        api_key=api_key,
    )
    target_lm = dspy.LM(
        f"anthropic/{target_model}",
        api_key=api_key,
    )
    dspy.configure(lm=target_lm)

    # Build signature with schema as structural constraint
    signature = make_signature(schema_text)
    predictor = WrapPredictor(signature, schema_text)

    # Run MIPRO — optimizes both instruction text and few-shot examples
    print("Running MIPROv2 optimization...")
    optimizer = dspy.MIPROv2(
        metric=wrap_metric,
        auto=None,
        num_candidates=num_candidates,
        prompt_model=teacher_lm,
        task_model=target_lm,
        max_bootstrapped_demos=4,
        max_labeled_demos=0,
        init_temperature=0.9,  # MIPRO adds epsilon (0.01-0.05); Anthropic caps at 1.0
    )

    # minibatch=False: evaluate on all examples every trial. Our dataset is small
    # enough that this is fast. Re-enable minibatching when dataset grows past ~100.
    optimized = optimizer.compile(
        predictor,
        trainset=trainset,
        num_trials=num_trials,
        minibatch=False,
        requires_permission_to_run=False,
    )

    # Extract optimized instruction + few-shot examples
    instruction = extract_instruction(optimized)
    demos = extract_demos(optimized)

    print(f"Optimized instruction ({len(instruction)} chars)")
    print(f"Extracted {len(demos)} few-shot examples")

    if instruction:
        print(f"\n--- Instruction preview ---\n{instruction[:500]}\n---")

    # Evaluate winning prompt on both sets through the bridge
    print("Evaluating winning prompt...")
    train_score, train_results = bridge_evaluate(trainset, "train", instruction, demos, schema_text)
    val_score, val_results = bridge_evaluate(valset, "val", instruction, demos, schema_text)

    # Write optimized prompt
    write_output(instruction, demos, schema_text, OUTPUT_PATH)

    # Write detailed eval results
    save_eval_results(
        teacher_model, target_model, num_candidates, num_trials,
        instruction, demos, train_score, val_score,
        train_results, val_results,
    )
    print("Done!")


if __name__ == "__main__":
    main()
