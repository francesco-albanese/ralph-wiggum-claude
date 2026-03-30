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
  echo "Run ralph-bootstrap first to create scripts/ralph/prompt.md"
  exit 1
fi

JQ_FILTER='
  if .type == "assistant" then
    (.message.content[] |
      if .type == "text" then "💬 \(.text)"
      elif .type == "tool_use" then "🔧 \(.name): \(.input | tostring)"
      else empty end)
  elif .type == "user" then
    (.message.content[]? | select(.type == "tool_result") |
      "  ↩ \(if (.content | type) == "string" then .content else (.content[]?.text // "") end)")
  elif .type == "result" then
    "✅ Done | turns=\(.num_turns) cost=$\(.total_cost_usd | tostring) time=\((.duration_ms / 1000 * 10 | floor) / 10)s"
  else empty end'

echo "Starting Ralph (AFK mode)"
echo "Max iterations: $MAX_ITERATIONS"
echo "Docker sandbox: $USE_DOCKER"
echo "---"

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "=== Iteration $i/$MAX_ITERATIONS ==="

  if $USE_DOCKER; then
    OUTPUT=$(docker sandbox run claude -p "$(cat "$SCRIPT_DIR/prompt.md")" 2>&1 | tee /dev/stderr) || true
  else
    OUTPUT=$(claude -p "$(cat "$SCRIPT_DIR/prompt.md")" \
      --dangerously-skip-permissions \
      --output-format stream-json \
      --verbose 2>/dev/null \
    | jq -r "$JQ_FILTER" \
    | tee /dev/stderr) || true
  fi

  if [[ "$OUTPUT" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "All tasks complete after $i iterations, exiting."
    exit 0
  fi

  sleep 2
done

echo "Max iterations ($MAX_ITERATIONS) reached"
exit 1
