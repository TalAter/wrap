FROM oven/bun:1 AS bun-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM python:3.12-slim
WORKDIR /app

# Bun runtime
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Python deps
COPY eval/dspy/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node modules from first stage (Linux binaries, not from macOS host)
COPY --from=bun-deps /app/node_modules node_modules/

# Python source
COPY eval/dspy/*.py eval/dspy/

# Bridge script
COPY eval/bridge.ts eval/

# Mount points at runtime:
#   /app/eval/examples — seed.jsonl
#   /app/src           — schema, constants, output

ENTRYPOINT ["python", "eval/dspy/optimize.py"]
