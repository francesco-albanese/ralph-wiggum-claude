#!/bin/bash
set -e

SCRIPT_DIR="scripts/ralph"

if [[ ! -f "$SCRIPT_DIR/prompt.md" ]]; then
  echo "Error: $SCRIPT_DIR/prompt.md not found"
  echo "Run ralph-bootstrap first to create scripts/ralph/prompt.md"
  exit 1
fi

echo "Running single Ralph iteration (HITL mode)..."

claude -p "$(cat "$SCRIPT_DIR/prompt.md")" \
  --permission-mode acceptEdits \
  --output-format stream-json \
  --verbose 2>/dev/null \
| jq -r '
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
