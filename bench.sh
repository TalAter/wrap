#!/usr/bin/env bash
set -euo pipefail

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }

commands=(
  "list all files"
  "show git status"
  "list all md files here"
  "what directory am I in"
  "count lines in package.json"
)
times=()

for cmd in "${commands[@]}"; do
  echo "=== w $cmd ==="
  start=$(now_ms)
  bun run src/index.ts $cmd 2>/dev/null || true
  end=$(now_ms)
  elapsed=$(( end - start ))
  times+=("$elapsed")
  echo "--- ${elapsed}ms ---"
  echo
  [[ ${#times[@]} -lt ${#commands[@]} ]] && sleep 5
done

echo "=== Summary ==="
total=0
for i in "${!times[@]}"; do
  echo "${times[$i]}ms  ${commands[$i]}"
  total=$(( total + ${times[$i]} ))
done
avg=$(( total / ${#times[@]} ))
echo "---"
echo "avg: ${avg}ms"
