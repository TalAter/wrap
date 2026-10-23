# Stage 1: the wrap binary. The optimizer drives it through the hidden
# `--eval-bridge` flag, so the prompt assembly and LLM path under test are
# the ones that ship.
FROM rust:slim-bookworm AS wrap-build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src src/
RUN cargo build --release --locked

# Stage 2: the Python optimizer.
FROM python:3.13-slim
WORKDIR /app

COPY eval/dspy/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=wrap-build /build/target/release/wrap /usr/local/bin/wrap

COPY eval/dspy/*.py eval/dspy/

# Mount points at runtime:
#   /app/eval/examples — seed.jsonl
#   /app/eval/results  — per-run eval results
#   /app/eval/dspy     — the optimizer sources (edits without a rebuild)
#   /app/src           — prompt constants, schema text, probed tools, optimized output

ENTRYPOINT ["python", "eval/dspy/optimize.py"]
