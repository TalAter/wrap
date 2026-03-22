"""Scoring function for evaluating LLM responses against assertions.

Hard gates: JSON must parse, type and risk_level must be valid schema values.
If any hard gate fails, score is 0. Then weighted scoring for assertion checks.
"""

import json
import re

VALID_TYPES = {"command", "probe", "answer"}
VALID_RISK_LEVELS = {"low", "medium", "high"}

# Weights for assertion checks (higher = more important)
WEIGHTS = {
    "type": 3.0,
    "risk_level": 3.0,
    "command_pattern": 2.0,
    "has_answer": 1.0,
    "answer_pattern": 1.0,
    "explanation_pattern": 1.0,
    "memory_updates_pattern": 1.0,
    "memory_updates_message_pattern": 1.0,
}


FENCE_RE = re.compile(r"^```\w*\s*\n(.*)\n```\s*$", re.DOTALL)

# Penalty for wrapping JSON in a single clean code fence
FENCE_PENALTY = 0.5


def strip_fences(text: str) -> tuple[str, bool]:
    """Strip markdown code fences only if the entire response is a single fenced block.
    Returns (cleaned text, had fences)."""
    m = FENCE_RE.match(text.strip())
    if m:
        inner = m.group(1)
        # Multiple code blocks = not a clean single-block response, don't strip
        if "```" in inner:
            return text, False
        return inner.strip(), True
    return text, False


def score(response_text: str, assertions: dict) -> float:
    """Score a response against assertions. Returns 0.0-1.0."""
    text, had_fences = strip_fences(response_text)

    # Hard gate: must be valid JSON
    try:
        response = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return 0.0

    if not isinstance(response, dict):
        return 0.0

    # Hard gate: type must be a valid schema value
    if response.get("type") not in VALID_TYPES:
        return 0.0

    # Hard gate: risk_level must be a valid schema value
    if response.get("risk_level") not in VALID_RISK_LEVELS:
        return 0.0

    checks = []

    # type must match expected
    if "type" in assertions:
        checks.append(("type", response["type"] == assertions["type"]))

    # risk_level must be within expected range
    if "risk_range" in assertions:
        checks.append(("risk_level", response["risk_level"] in assertions["risk_range"]))

    # command must match regex pattern
    if "command_pattern" in assertions:
        cmd = response.get("command", "")
        checks.append((
            "command_pattern",
            bool(re.search(assertions["command_pattern"], cmd or "", re.IGNORECASE)),
        ))

    # answer must be non-empty when expected
    if "has_answer" in assertions:
        answer = response.get("answer", "")
        checks.append(("has_answer", bool(answer and answer.strip())))

    # answer must match pattern
    if "answer_pattern" in assertions:
        answer = response.get("answer", "")
        checks.append((
            "answer_pattern",
            bool(re.search(assertions["answer_pattern"], answer or "", re.IGNORECASE)),
        ))

    # explanation must match pattern
    if "explanation_pattern" in assertions:
        explanation = response.get("explanation", "")
        checks.append((
            "explanation_pattern",
            bool(
                re.search(
                    assertions["explanation_pattern"],
                    explanation or "",
                    re.IGNORECASE,
                )
            ),
        ))

    # memory_updates keys must match pattern
    if "memory_updates_pattern" in assertions:
        updates = response.get("memory_updates") or []
        if not isinstance(updates, list):
            updates = []
        keys = " ".join(u.get("fact", "") for u in updates if isinstance(u, dict))
        checks.append((
            "memory_updates_pattern",
            bool(re.search(assertions["memory_updates_pattern"], keys, re.IGNORECASE)),
        ))

    # memory_updates_message must match pattern
    if "memory_updates_message_pattern" in assertions:
        msg = response.get("memory_updates_message", "")
        checks.append((
            "memory_updates_message_pattern",
            bool(
                re.search(
                    assertions["memory_updates_message_pattern"],
                    msg or "",
                    re.IGNORECASE,
                )
            ),
        ))

    if not checks:
        return 0.0

    weighted_sum = sum(WEIGHTS.get(name, 1.0) * passed for name, passed in checks)
    max_sum = sum(WEIGHTS.get(name, 1.0) for name, _ in checks)
    result = weighted_sum / max_sum

    if had_fences:
        result *= FENCE_PENALTY

    return result
