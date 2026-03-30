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


def call_bridge(mode, instruction, demos, schema_text, memory, tools_output, cwd, piped, query):
    """Call the TS bridge as a subprocess. Returns parsed JSON output or None on crash."""
    payload = json.dumps({
        "mode": mode,
        "instruction": instruction,
        "fewShotExamples": demos,
        "schemaText": schema_text,
        "memory": memory,
        "toolsOutput": tools_output,
        "cwd": cwd,
        "piped": piped,
        "query": query,
    })
    try:
        result = subprocess.run(
            ["bun", "run", BRIDGE_PATH],
            input=payload, capture_output=True, text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        print("Bridge call timed out (120s)", file=sys.stderr)
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

        memory: dict = dspy.InputField(
            desc="Scoped memory facts about the user's environment",
            default={},
        )
        tools_output: str = dspy.InputField(
            desc="Output of tool detection probes",
            default="",
        )
        cwd: str = dspy.InputField(
            desc="Current working directory",
            default="/",
        )
        piped: bool = dspy.InputField(
            desc="Whether stdout is piped to another program",
            default=False,
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

        response, error_type = call_bridge_execute(
            instruction=instruction,
            demos=demos,
            schema_text=self.schema_text,
            memory=kwargs["memory"],
            tools_output=kwargs["tools_output"],
            cwd=kwargs["cwd"],
            piped=kwargs.get("piped", False),
            query=kwargs["natural_language_query"],
        )

        # response_json as JSON string: DSPy signature declares it as str,
        # and MIPRO stores successful predictions as demos where
        # demo.response_json is read back as a string for few-shot examples.
        return dspy.Prediction(
            response_json=json.dumps(response) if response else None,
            response_dict=response,
            error_type=error_type,
        )


def wrap_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """DSPy-compatible metric function. Handles bridge error types."""
    error_type = getattr(prediction, "error_type", None)
    if error_type is not None:
        return 0.0
    return score(prediction.response_dict, example.assertions)


# Defaults applied to every example unless overridden.
# At runtime the LLM always sees system facts + tools output,
# so eval samples should reflect that.
DEFAULT_CWD = "/Users/talater/project"
DEFAULT_MEMORY = {"/": [{"fact": "Runs macOS on arm64 (Apple Silicon)"}, {"fact": "Default shell is zsh"}]}
DEFAULT_TOOLS_OUTPUT = (
    "/opt/homebrew/bin/brew\napt not found\ndnf not found\npacman not found\nyum not found\n"
    "/usr/bin/git\ndocker not found\nkubectl not found\n/opt/homebrew/bin/python3\n"
    "/usr/local/bin/node\n/Users/tal/.bun/bin/bun\n/usr/bin/curl\n/usr/bin/jq\n"
    "tldr not found\nrg not found\nfd not found\nbat not found\n/opt/homebrew/bin/eza\n"
    "/usr/bin/pbcopy\n/usr/bin/pbpaste\nxclip not found\nxsel not found\n"
    "wl-copy not found\nwl-paste not found"
)


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
                tools_output=ex.get("tools_output", DEFAULT_TOOLS_OUTPUT),
                cwd=ex.get("cwd", DEFAULT_CWD),
                piped=ex.get("piped", False),
                natural_language_query=ex["input"],
                assertions=ex["assertions"],
            ).with_inputs("memory", "tools_output", "cwd", "piped", "natural_language_query")
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
            keys = list(demo.keys())
            inp = demo.get("natural_language_query", "")
            out = demo.get("response_json", "")
        else:
            keys = list(demo.keys()) if hasattr(demo, "keys") else dir(demo)
            inp = getattr(demo, "natural_language_query", "")
            out = getattr(demo, "response_json", "")
        print(f"  Demo {i}: keys={keys}, has_input={bool(inp)}, has_output={bool(out)}")
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
        ["SECTION_USER_REQUEST", CONSTANTS["sectionUserRequest"]],
        ["CWD_PREFIX", CONSTANTS["cwdPrefix"]],
        ["PIPED_OUTPUT_INSTRUCTION", CONSTANTS["pipedOutputInstruction"]],
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


def bridge_evaluate(val_examples, instruction, demos, schema_text):
    """Evaluate the winning candidate through the bridge on the validation set."""
    scores = []
    for ex in val_examples:
        response, error_type = call_bridge_execute(
            instruction=instruction,
            demos=demos,
            schema_text=schema_text,
            memory=ex.memory,
            tools_output=ex.tools_output,
            cwd=ex.cwd,
            piped=ex.piped,
            query=ex.natural_language_query,
        )
        if error_type is not None:
            scores.append(0.0)
        else:
            scores.append(score(response, ex.assertions))
    avg = sum(scores) / len(scores) if scores else 0.0
    print(f"Bridge eval: {avg:.3f} ({len(scores)} examples)")
    return avg


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
        init_temperature=1.0,
    )

    # minibatch=False: evaluate on all examples every trial. Our dataset is small
    # enough that this is fast. Re-enable minibatching when dataset grows past ~100.
    optimized = optimizer.compile(
        predictor,
        trainset=trainset,
        num_trials=num_trials,
        minibatch=False,
    )

    # Extract optimized instruction + few-shot examples
    instruction = extract_instruction(optimized)
    demos = extract_demos(optimized)

    print(f"Optimized instruction ({len(instruction)} chars)")
    print(f"Extracted {len(demos)} few-shot examples")

    if instruction:
        print(f"\n--- Instruction preview ---\n{instruction[:500]}\n---")

    # Evaluate on validation set through the bridge
    print("Evaluating on validation set...")
    bridge_evaluate(valset, instruction, demos, schema_text)

    # Write output
    write_output(instruction, demos, schema_text, OUTPUT_PATH)
    print("Done!")


if __name__ == "__main__":
    main()
