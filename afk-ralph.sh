#!/bin/bash
set -e

SCRIPT_DIR="scripts/ralph"
MAX_ITERATIONS=${1:-10}
USE_DOCKER=false

# Parse --docker flag
for arg in "$@"; do
  [[ "$arg" == "--docker" ]] && USE_DOCKER=true
done

# Remove --docker from positional args for iteration count
[[ "$1" =~ ^[0-9]+$ ]] && MAX_ITERATIONS=$1

if [[ ! -f "$SCRIPT_DIR/prompt.md" ]]; then
  echo "Error: $SCRIPT_DIR/prompt.md not found"
  echo "Create scripts/ralph/ directory with prompt.md, prd.json, progress.txt"
  exit 1
fi

echo "Starting Ralph (AFK mode)"
echo "Max iterations: $MAX_ITERATIONS"
echo "Docker sandbox: $USE_DOCKER"
echo "---"

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "=== Iteration $i/$MAX_ITERATIONS ==="

  if $USE_DOCKER; then
    OUTPUT=$(docker sandbox run claude -p "$(cat "$SCRIPT_DIR/prompt.md")" 2>&1 | tee /dev/stderr) || true
  else
    OUTPUT=$(cat "$SCRIPT_DIR/prompt.md" | claude --permission-mode acceptEdits 2>&1 | tee /dev/stderr) || true
  fi

  if [[ "$OUTPUT" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "PRD complete after $i iterations, exiting."
    exit 0
  fi

  sleep 2
done

echo "Max iterations ($MAX_ITERATIONS) reached"
exit 1
