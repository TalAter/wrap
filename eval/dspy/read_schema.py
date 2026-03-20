"""Extract Zod schema text from src/response.schema.ts between marker comments."""

import re
from pathlib import Path

SCHEMA_PATH = Path("/app/src/response.schema.ts")
START_MARKER = "// SCHEMA_START"
END_MARKER = "// SCHEMA_END"


def read_schema(path: Path = SCHEMA_PATH) -> str:
    """Return the raw Zod schema text between SCHEMA_START and SCHEMA_END markers."""
    text = path.read_text()
    match = re.search(
        rf"{re.escape(START_MARKER)}\n(.*?)\n{re.escape(END_MARKER)}",
        text,
        re.DOTALL,
    )
    if not match:
        raise ValueError(
            f"Could not find schema markers ({START_MARKER} / {END_MARKER}) in {path}"
        )
    return match.group(1).strip()


if __name__ == "__main__":
    print(read_schema())
