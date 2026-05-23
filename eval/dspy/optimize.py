"""DSPy optimizer for Wrap's system prompt.

Reads the Zod schema (with inline comments), loads examples, runs GEPA
optimization to discover the best instruction text, and writes the result
to src/prompt.optimized.json.

The Zod schema's inline comments serve as structural guidance for the LLM —
they explain what each type means, when to use probe vs command, etc. GEPA
optimizes the instruction text around this fixed schema.
"""

import hashlib
import json
import os
import random
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import dspy
from diskcache import FanoutCache
from dspy.teleprompt.gepa.gepa_utils import ScoreWithFeedback

from metric import score
from read_schema import read_schema

# Paths (container mount points)
EXAMPLES_PATH = Path("/app/eval/examples/seed.jsonl")
CONSTANTS_PATH = Path("/app/src/prompt.constants.json")
PROBED_TOOLS_PATH = Path("/app/src/skills/probed-tools.json")
OUTPUT_PATH = Path("/app/src/prompt.optimized.json")

SEED = 42

# ── Prompt string constants ─────────────────────────────────────────────
with open(CONSTANTS_PATH) as _f:
    CONSTANTS = json.load(_f)
with open(PROBED_TOOLS_PATH) as _f:
    PROBED_TOOLS = json.load(_f)

BRIDGE_PATH = "/app/eval/bridge.ts"

# ── Bridge-level cache ──────────────────────────────────────────────────
BRIDGE_CACHE_DIR = os.environ.get("BRIDGE_CACHEDIR", "/tmp/wrap-bridge-cache")
_bridge_cache = FanoutCache(BRIDGE_CACHE_DIR, shards=8, size_limit=int(1e10))


def _bridge_cache_key(payload_dict: dict) -> str:
    canonical = json.dumps(payload_dict, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def call_bridge(mode, instruction, schema_text, memory, cwd, piped, query, extra_messages=None, last_round=False, attached_input=None):
    """Call the TS bridge as a subprocess. Returns parsed JSON output or None on crash.

    Tool probe results and cwd files flow via `extra_messages` as transcript
    turns — the runtime discovery skill emits them, and examples encode them
    as assistant probe + step output pairs.
    """
    payload_dict = {
        "mode": mode,
        "instruction": instruction,
        "fewShotExamples": [],
        "schemaText": schema_text,
        "memory": memory,
        "cwd": cwd,
        "piped": piped,
        "query": query,
    }
    if extra_messages is not None:
        payload_dict["extraMessages"] = extra_messages
    if last_round:
        payload_dict["lastRound"] = True
    if attached_input is not None:
        payload_dict["attachedInputPath"] = "$WRAP_TEMP_DIR/input"
        payload_dict["attachedInputSize"] = len(attached_input.encode("utf-8"))
        payload_dict["attachedInputPreview"] = attached_input
        payload_dict["attachedInputTruncated"] = False

    cache_key = _bridge_cache_key(payload_dict)
    cached = _bridge_cache.get(cache_key)
    if cached is not None:
        return cached

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
        parsed = json.loads(result.stdout)
        _bridge_cache.set(cache_key, parsed)
        return parsed
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
        """Translate natural language into shell commands. Return JSON."""

        memory: str = dspy.InputField(
            desc="Scoped memory facts about the user's environment (JSON dict)",
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
        extra_messages: str = dspy.InputField(
            desc="Prior conversation turns (non-final step responses + captured outputs) for multi-round eval. Discovery probe output (pwd/ls/which) is encoded here too.",
            default="",
        )
        last_round: str = dspy.InputField(
            desc="Whether this is the last available round (LLM must respond with final:true or reply)",
            default="",
        )
        attached_input: str = dspy.InputField(
            desc="Preview of content the user piped to stdin (e.g. `cat file | w explain this`).",
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
        instruction = self.predict.signature.instructions

        extra_messages = kwargs.get("extra_messages")
        last_round = kwargs.get("last_round", False)
        attached_input = kwargs.get("attached_input")
        response, error_type = call_bridge_execute(
            instruction=instruction,
            schema_text=self.schema_text,
            memory=kwargs["memory"],
            cwd=kwargs["cwd"],
            piped=kwargs.get("piped", False),
            query=kwargs["natural_language_query"],
            extra_messages=extra_messages,
            last_round=last_round,
            attached_input=attached_input,
        )

        prediction = dspy.Prediction(
            response_json=json.dumps(response) if response else None,
            response_dict=response,
            error_type=error_type,
        )

        # Register a trace entry so GEPA's reflective dataset builder can
        # map this prediction back to self.predict. Without this, GEPA sees
        # "No valid predictions found" and can't do reflective mutation.
        trace = getattr(dspy.settings, "trace", None)
        if trace is not None:
            trace.append((self.predict, dict(**kwargs), prediction))

        return prediction


# ── GEPA metric ─────────────────────────────────────────────────────────

def _format_failed_assertions(response: dict, assertions: dict) -> str:
    """Build a human-readable string explaining which assertions failed."""
    parts = []

    if "type" in assertions:
        expected = assertions["type"]
        actual = response.get("type")
        if isinstance(expected, list):
            if actual not in expected:
                parts.append(f"type: expected one of {expected}, got '{actual}'")
        elif actual != expected:
            parts.append(f"type: expected '{expected}', got '{actual}'")

    if "final_expected" in assertions:
        actual = response.get("final", True)
        if actual != assertions["final_expected"]:
            parts.append(f"final: expected {assertions['final_expected']}, got {actual}")

    if "risk_range" in assertions:
        actual = response.get("risk_level")
        if actual not in assertions["risk_range"]:
            parts.append(f"risk_level: expected one of {assertions['risk_range']}, got '{actual}'")

    if "content_pattern" in assertions:
        content = response.get("content", "")
        pattern = assertions["content_pattern"]
        if not re.search(pattern, content or "", re.IGNORECASE):
            parts.append(f"content should match /{pattern}/ but was: {(content or '')[:120]}")

    if "content_forbidden_pattern" in assertions:
        content = response.get("content", "")
        pattern = assertions["content_forbidden_pattern"]
        if re.search(pattern, content or "", re.IGNORECASE):
            parts.append(f"content must NOT match /{pattern}/ but did: {(content or '')[:120]}")

    if "no_memory_updates" in assertions and assertions["no_memory_updates"]:
        updates = response.get("memory_updates") or []
        if isinstance(updates, list) and len(updates) > 0:
            parts.append(f"expected no memory_updates but got {len(updates)}")

    return "; ".join(parts) if parts else "unknown assertion failure"


def wrap_metric(gold, pred, trace=None, pred_name=None, pred_trace=None):
    """GEPA-compatible metric. Returns ScoreWithFeedback so GEPA's
    auto-generated feedback_map picks up targeted failure explanations.
    """
    error_type = getattr(pred, "error_type", None)
    if error_type is not None:
        return ScoreWithFeedback(score=0.0, feedback=f"Bridge error: {error_type}")
    s = score(pred.response_dict, gold.assertions)
    if s < 1.0:
        feedback = _format_failed_assertions(pred.response_dict, gold.assertions)
        return ScoreWithFeedback(score=s, feedback=feedback)
    return ScoreWithFeedback(score=s, feedback="")


# Defaults applied to every example unless overridden.
DEFAULT_CWD = "/Users/talater/project"
DEFAULT_MEMORY = {"/": [{"fact": "Runs macOS on arm64 (Apple Silicon)"}, {"fact": "Default shell is zsh"}]}


def examples_to_dspy(examples: list[dict]) -> list[dspy.Example]:
    """Probe state (tools, cwdFiles) belongs in `extra_messages` as transcript
    turns — the bridge no longer accepts top-level `tools` / `cwdFiles` fields.
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
                cwd=ex.get("cwd", DEFAULT_CWD),
                piped=ex.get("piped", False),
                extra_messages=ex.get("extra_messages"),
                last_round=ex.get("last_round", False),
                attached_input=ex.get("attachedInput"),
                natural_language_query=ex["input"],
                assertions=ex["assertions"],
            ).with_inputs("memory", "cwd", "piped", "extra_messages", "last_round", "attached_input", "natural_language_query")
        )
    return dspy_examples


def extract_instruction(optimized) -> str:
    """Extract the optimized instruction text from the compiled program."""
    predict = optimized.predict
    sig = getattr(predict, "signature", None)

    if sig:
        instructions = getattr(sig, "instructions", None)
        if instructions and isinstance(instructions, str):
            return instructions
        if sig.__doc__:
            return sig.__doc__

    print("WARNING: Could not extract instruction from optimized program")
    print(f"  predict type: {type(predict)}")
    if sig:
        print(f"  signature attrs: {[a for a in dir(sig) if not a.startswith('_')]}")
    return ""


def build_prompt_hash_manifest(
    instruction: str, schema_text: str,
) -> list[list[object]]:
    """Return the static prompt surface that PROMPT_HASH versions."""
    return [
        ["SYSTEM_PROMPT", (instruction or "").strip()],
        ["MEMORY_RECENCY_INSTRUCTION", CONSTANTS["memoryRecencyInstruction"]],
        ["TOOLS_SCOPE_INSTRUCTION", CONSTANTS["toolsScopeInstruction"]],
        ["VOICE_INSTRUCTIONS", CONSTANTS["voiceInstructions"]],
        ["TEMP_DIR_PRINCIPLE", CONSTANTS["tempDirPrinciple"]],
        ["FINAL_FLAG_INSTRUCTION", CONSTANTS["finalFlagInstruction"]],
        ["WRAP_NOTE_INSTRUCTION", CONSTANTS["wrapNoteInstruction"]],
        ["ATTACHED_INPUT_INSTRUCTION", CONSTANTS["attachedInputInstruction"]],
        ["SCHEMA_INSTRUCTION", CONSTANTS["schemaInstruction"]],
        ["SCHEMA_TEXT", (schema_text or "").strip()],
        ["FEW_SHOT_EXAMPLES", []],
        ["FEW_SHOT_SEPARATOR", CONSTANTS["fewShotSeparator"]],
        ["SECTION_SYSTEM_FACTS", CONSTANTS["sectionSystemFacts"]],
        ["SECTION_FACTS_ABOUT", CONSTANTS["sectionFactsAbout"]],
        ["SECTION_ATTACHED_INPUT", CONSTANTS["sectionAttachedInput"]],
        ["PIPED_OUTPUT_INSTRUCTION", CONSTANTS["pipedOutputInstruction"]],
        ["SECTION_USER_REQUEST", CONSTANTS["sectionUserRequest"]],
        ["SECTION_CAPTURED_OUTPUT", CONSTANTS["sectionCapturedOutput"]],
        ["CAPTURED_NO_OUTPUT", CONSTANTS["capturedNoOutput"]],
        ["LAST_ROUND_INSTRUCTION", CONSTANTS["lastRoundInstruction"]],
        ["SCRATCHPAD_REQUIRED_INSTRUCTION", CONSTANTS["scratchpadRequiredInstruction"]],
        ["JSON_RETRY_INSTRUCTION", CONSTANTS["jsonRetryInstruction"]],
        ["SECTION_TEMP_DIR", CONSTANTS["sectionTempDir"]],
        ["TEMP_DIR_EMPTY", CONSTANTS["tempDirEmpty"]],
        ["PROBED_TOOLS", PROBED_TOOLS],
    ]


def compute_prompt_hash(instruction: str, schema_text: str) -> str:
    manifest = build_prompt_hash_manifest(instruction, schema_text)
    hash_input = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(hash_input.encode()).hexdigest()


def write_output(instruction: str, schema_text: str, path: Path) -> None:
    prompt_hash = compute_prompt_hash(instruction, schema_text)
    output = {
        "instruction": instruction,
        "fewShotExamples": [],
        "schemaText": schema_text,
        "promptHash": prompt_hash,
    }
    with open(path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote optimized prompt to {path} (hash: {prompt_hash})")


def bridge_evaluate(examples, split, instruction, schema_text):
    """Evaluate a prompt through the bridge. Returns (avg_score, results_list)."""
    results = []
    for ex in examples:
        attached_input = getattr(ex, "attached_input", None)
        extra_messages = getattr(ex, "extra_messages", None)
        last_round = getattr(ex, "last_round", False)
        response, error_type = call_bridge_execute(
            instruction=instruction,
            schema_text=schema_text,
            memory=ex.memory,
            cwd=ex.cwd,
            piped=ex.piped,
            query=ex.natural_language_query,
            attached_input=attached_input,
            extra_messages=extra_messages,
            last_round=last_round,
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
    teacher_model, target_model, budget,
    instruction, train_score, val_score,
    train_results, val_results,
):
    ts = datetime.now(timezone.utc)
    output = {
        "timestamp": ts.isoformat(),
        "optimizer": "GEPA",
        "models": {"teacher": teacher_model, "target": target_model},
        "budget": budget,
        "winning_instruction": instruction,
        "training_score": round(train_score, 3),
        "validation_score": round(val_score, 3),
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
    teacher_model = os.environ.get("TEACHER_MODEL", "claude-opus-4-7")
    target_model = os.environ.get("TARGET_MODEL", "claude-sonnet-4-6")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    budget = os.environ.get("GEPA_BUDGET", "medium")
    num_threads = int(os.environ.get("NUM_THREADS", "16"))

    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set in environment", file=sys.stderr)
        sys.exit(1)

    os.environ["WRAP_CONFIG"] = json.dumps({
        "providers": {
            "anthropic": {
                "model": target_model,
                "apiKey": "$ANTHROPIC_API_KEY",
            }
        },
        "defaultProvider": "anthropic",
    })

    print(f"Reflection model: {teacher_model}")
    print(f"Target model: {target_model}")
    print(f"GEPA budget: {budget}, threads: {num_threads}")

    schema_text = read_schema()
    print(f"Loaded schema ({len(schema_text)} chars)")

    raw_examples = load_examples(EXAMPLES_PATH)
    dspy_examples = examples_to_dspy(raw_examples)
    print(f"Loaded {len(dspy_examples)} examples")

    # Stratified split
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

    # Reflection LM (proposes instruction mutations based on failure feedback).
    # additional_drop_params strips temperature for Opus 4.7 which rejects it
    # (LiteLLM bug #26444 — still open, no version fixes it).
    reflection_lm = dspy.LM(
        f"anthropic/{teacher_model}",
        api_key=api_key,
        additional_drop_params=["temperature"],
    )
    target_lm = dspy.LM(
        f"anthropic/{target_model}",
        api_key=api_key,
    )
    dspy.configure(lm=target_lm)

    signature = make_signature(schema_text)
    predictor = WrapPredictor(signature, schema_text)

    print(f"Running GEPA optimization (budget={budget})...")
    optimizer = dspy.GEPA(
        metric=wrap_metric,
        auto=budget,
        reflection_lm=reflection_lm,
        num_threads=num_threads,
        log_dir="/app/eval/gepa-logs",
        track_stats=True,
        seed=SEED,
    )

    optimized = optimizer.compile(
        predictor,
        trainset=trainset,
        valset=valset,
    )

    instruction = extract_instruction(optimized)
    print(f"Optimized instruction ({len(instruction)} chars)")
    if instruction:
        print(f"\n--- Instruction preview ---\n{instruction[:500]}\n---")

    # Final eval through the bridge
    print("Evaluating winning prompt...")
    train_score, train_results = bridge_evaluate(trainset, "train", instruction, schema_text)
    val_score, val_results = bridge_evaluate(valset, "val", instruction, schema_text)

    write_output(instruction, schema_text, OUTPUT_PATH)

    save_eval_results(
        teacher_model, target_model, budget,
        instruction, train_score, val_score,
        train_results, val_results,
    )
    print("Done!")


if __name__ == "__main__":
    main()
