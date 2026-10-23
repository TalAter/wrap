"""Read the schema text the LLM sees from src/prompt/schema.txt."""

from pathlib import Path

SCHEMA_PATH = Path("/app/src/prompt/schema.txt")


def read_schema(path: Path = SCHEMA_PATH) -> str:
    """Return the schema source with its guiding comments, surrounding whitespace stripped."""
    text = path.read_text().strip()
    if not text:
        raise ValueError(f"Schema file is empty: {path}")
    return text


if __name__ == "__main__":
    print(read_schema())
