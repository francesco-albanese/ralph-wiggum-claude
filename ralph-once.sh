#!/bin/bash
set -e

SCRIPT_DIR="scripts/ralph"

if [[ ! -f "$SCRIPT_DIR/prompt.md" ]]; then
  echo "Error: $SCRIPT_DIR/prompt.md not found"
  echo "Create scripts/ralph/ directory with prompt.md, prd.json, progress.txt"
  exit 1
fi

echo "Running single Ralph iteration (HITL mode)..."
cat "$SCRIPT_DIR/prompt.md" | claude --permission-mode acceptEdits
