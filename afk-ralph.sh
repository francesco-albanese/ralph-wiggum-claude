#!/bin/bash
set -e

SCRIPT_DIR="scripts/ralph"
MAX_ITERATIONS=10
USE_DOCKER=false
MILESTONE=""
EXTRA_INSTRUCTIONS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)
      USE_DOCKER=true
      shift
      ;;
    --milestone)
      MILESTONE="$2"
      shift 2
      ;;
    --instructions)
      EXTRA_INSTRUCTIONS="$2"
      shift 2
      ;;
    *)
      [[ "$1" =~ ^[0-9]+$ ]] && MAX_ITERATIONS="$1"
      shift
      ;;
  esac
done

if [[ ! -f "$SCRIPT_DIR/prompt.md" ]]; then
  echo "Error: $SCRIPT_DIR/prompt.md not found"
  echo "Run ralph-bootstrap first to create scripts/ralph/prompt.md"
  exit 1
fi

TRACKER="github"
if head -1 "$SCRIPT_DIR/prompt.md" | grep -q "tracker: beads"; then
  TRACKER="beads"
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

PROMPT="$(cat "$SCRIPT_DIR/prompt.md")"

if [[ -n "$MILESTONE" ]]; then
  if [[ "$TRACKER" == "beads" ]]; then
    SLUG=$(echo "$MILESTONE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    PROMPT="$PROMPT

## Milestone Scope

You are scoped to the milestone: \"$MILESTONE\" (label: \`milestone:$SLUG\`).

When listing tasks, ALWAYS include the milestone filter:
\`\`\`bash
bd ready --type task --label milestone:$SLUG
\`\`\`

When creating or updating beads, apply \`--label milestone:$SLUG\`.
Do NOT pick up tasks that lack this label. Skip and pick a different free task.
When updating the progress log, note that you worked on milestone \"$MILESTONE\"."
  else
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
fi

if [[ -n "$EXTRA_INSTRUCTIONS" ]]; then
  PROMPT="$PROMPT

## Additional Instructions

$EXTRA_INSTRUCTIONS"
fi

echo "Starting Ralph (AFK mode)"
echo "Tracker: $TRACKER"
echo "Max iterations: $MAX_ITERATIONS"
echo "Docker sandbox: $USE_DOCKER"
[[ -n "$MILESTONE" ]] && echo "Milestone: $MILESTONE"
[[ -n "$EXTRA_INSTRUCTIONS" ]] && echo "Extra instructions: (provided)"
echo "---"

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "=== Iteration $i/$MAX_ITERATIONS ==="

  if $USE_DOCKER; then
    OUTPUT=$(docker sandbox run claude -p "$PROMPT" 2>&1 | tee /dev/stderr) || true
  else
    OUTPUT=$(claude -p "$PROMPT" \
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
