# Ralph Wiggum Claude

Reusable bash scripts for Ralph Wiggum approach - autonomous AI coding loops with Claude Code.

## What is Ralph?

Ralph runs Claude Code in a loop, letting it work autonomously on tasks from GitHub issues. Two modes:
- **HITL (ralph-once)**: Single iteration, watch and intervene
- **AFK (afk-ralph)**: Loop with max iterations, unsupervised

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- `jq` installed

## Install Globally

```bash
# Clone once
git clone git@github.com:francesco-albanese/ralph-wiggum-claude.git ~/Documents/Development/ralph-wiggum-claude

# Ensure ~/.local/bin exists and is in PATH
mkdir -p ~/.local/bin
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc

# Symlink scripts
ln -s ~/Documents/Development/ralph-wiggum-claude/ralph-once.sh ~/.local/bin/ralph-once
ln -s ~/Documents/Development/ralph-wiggum-claude/afk-ralph.sh ~/.local/bin/afk-ralph

# Reload shell
source ~/.zshrc
```

Update scripts:
```bash
cd ~/Documents/Development/ralph-wiggum-claude && git pull
```

## Usage

### Setup (per project)

**Option 1: Claude Code skill** (recommended)

```text
/ralph-bootstrap
```

Creates `scripts/ralph/` and copies the prompt template.

**Option 2: Manual**

```bash
cd ~/any-project
mkdir -p scripts/ralph
cp ~/Documents/Development/ralph-wiggum-claude/templates/prompt.md scripts/ralph/
```

### Recommended workflow

1. `/write-a-prd` — create PRD as GitHub issue
2. `/prd-to-issues` — break PRD into task issues + create progress log
3. `/ralph-bootstrap` — set up local prompt in project
4. `ralph-once` or `afk-ralph` — run autonomous coding loops

### Run

```bash
# HITL mode - single iteration
ralph-once

# AFK mode - 10 iterations (default)
afk-ralph

# AFK mode - custom iterations
afk-ralph 25

# AFK mode - with Docker sandbox (safer)
afk-ralph 25 --docker
```

## Files Structure

```text
scripts/ralph/
└── prompt.md      # Instructions for Claude (reads tasks from GitHub issues)
```

## How It Works

Each iteration:

1. Queries GitHub issues with `task` label (excluding `done` and `in-progress`)
2. Checks dependencies and picks highest priority task
3. Locks the task with `in-progress` label
4. Reads progress log for prior context
5. Implements the task
6. Runs feedback loops (discovers checks from project config)
7. Commits if passing
8. Marks task done, swaps labels, closes issue
9. Updates progress log with iteration summary
10. Exits with `<promise>COMPLETE</promise>` when all tasks are done
