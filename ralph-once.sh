#!/bin/bash
set -e

SCRIPT_DIR="scripts/ralph"
MILESTONE=""
EXTRA_INSTRUCTIONS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --milestone)
      MILESTONE="$2"
      shift 2
      ;;
    --instructions)
      EXTRA_INSTRUCTIONS="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ ! -f "$SCRIPT_DIR/prompt.md" ]]; then
  echo "Error: $SCRIPT_DIR/prompt.md not found"
  echo "Run ralph-bootstrap first to create scripts/ralph/prompt.md"
  exit 1
fi

PROMPT="$(cat "$SCRIPT_DIR/prompt.md")"

if [[ -n "$MILESTONE" ]]; then
  PROMPT="$PROMPT

## Milestone Scope

You are scoped to the milestone: \"$MILESTONE\"

When listing tasks, ALWAYS include the milestone filter:
\`\`\`bash
gh issue list --label \"task\" --milestone \"$MILESTONE\" --search '-label:\"in-progress\" -label:done'
\`\`\`

Do NOT pick up tasks from other milestones. If a task has no milestone or belongs to a different milestone, skip it.
When updating the progress log, note that you worked on milestone \"$MILESTONE\"."
fi

if [[ -n "$EXTRA_INSTRUCTIONS" ]]; then
  PROMPT="$PROMPT

## Additional Instructions

$EXTRA_INSTRUCTIONS"
fi

echo "Running single Ralph iteration (HITL mode)..."
[[ -n "$MILESTONE" ]] && echo "Milestone: $MILESTONE"
[[ -n "$EXTRA_INSTRUCTIONS" ]] && echo "Extra instructions: (provided)"

claude -p "$PROMPT" \
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
