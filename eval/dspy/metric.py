"""Scoring function for evaluating validated LLM responses against assertions.

The bridge validates responses with Zod before scoring. This module only does
weighted assertion checks against already-validated response dicts.
"""

import re

# Weights for assertion checks (higher = more important)
WEIGHTS = {
    "type": 3.0,
    "risk_level": 3.0,
    "content_pattern": 2.0,
    "content_forbidden_pattern": 2.0,
    "explanation_pattern": 1.0,
    "memory_updates_pattern": 1.0,
    "memory_updates_scope_pattern": 1.0,
    "memory_updates_count": 1.0,
    "memory_updates_message_pattern": 1.0,
}


def score(response: dict, assertions: dict) -> float:
    """Score a validated response dict against assertions. Returns 0.0-1.0."""
    checks = []

    # type must match expected
    if "type" in assertions:
        checks.append(("type", response["type"] == assertions["type"]))

    # risk_level must be within expected range
    if "risk_range" in assertions:
        checks.append(("risk_level", response["risk_level"] in assertions["risk_range"]))

    # content must match regex pattern
    if "content_pattern" in assertions:
        content = response.get("content", "")
        checks.append((
            "content_pattern",
            bool(re.search(assertions["content_pattern"], content or "", re.IGNORECASE)),
        ))

    # content must not match forbidden regex pattern
    if "content_forbidden_pattern" in assertions:
        content = response.get("content", "")
        checks.append((
            "content_forbidden_pattern",
            not bool(
                re.search(
                    assertions["content_forbidden_pattern"], content or "", re.IGNORECASE
                )
            ),
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

    # memory_updates facts must match pattern
    if "memory_updates_pattern" in assertions:
        updates = response.get("memory_updates") or []
        if not isinstance(updates, list):
            updates = []
        facts = " ".join(u.get("fact", "") for u in updates if isinstance(u, dict))
        checks.append((
            "memory_updates_pattern",
            bool(re.search(assertions["memory_updates_pattern"], facts, re.IGNORECASE)),
        ))

    # memory_updates scopes must match pattern
    if "memory_updates_scope_pattern" in assertions:
        updates = response.get("memory_updates") or []
        if not isinstance(updates, list):
            updates = []
        scopes = " ".join(u.get("scope", "") for u in updates if isinstance(u, dict))
        checks.append((
            "memory_updates_scope_pattern",
            bool(re.search(assertions["memory_updates_scope_pattern"], scopes, re.IGNORECASE)),
        ))

    # memory_updates count must match expected
    if "memory_updates_count" in assertions:
        updates = response.get("memory_updates") or []
        if not isinstance(updates, list):
            updates = []
        checks.append((
            "memory_updates_count",
            len(updates) == assertions["memory_updates_count"],
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
        return 1.0

    weighted_sum = sum(WEIGHTS.get(name, 1.0) * passed for name, passed in checks)
    max_sum = sum(WEIGHTS.get(name, 1.0) for name, _ in checks)
    return weighted_sum / max_sum
