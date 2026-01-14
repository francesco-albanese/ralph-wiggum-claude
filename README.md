# Ralph Wiggum Claude

Reusable bash scripts for Ralph Wiggum approach - autonomous AI coding loops with Claude Code.

## What is Ralph?

Ralph runs Claude Code in a loop, letting it work autonomously on tasks. Two modes:
- **HITL (ralph-once)**: Single iteration, watch and intervene
- **AFK (afk-ralph)**: Loop with max iterations, unsupervised

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

Creates `scripts/ralph/` and copies all templates.

**Option 2: Manual**

```bash
cd ~/any-project
mkdir -p scripts/ralph
cp ~/Documents/Development/ralph-wiggum-claude/templates/* scripts/ralph/
```

Then edit `prd.json` with your tasks and `prompt.md` if needed.

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
├── prompt.md      # Instructions for Claude
├── prd.json       # Task list (user stories)
└── progress.txt   # Progress log between iterations
```

## How It Works

Each iteration:

1. Reads prd.json for pending tasks
2. Reads progress.txt for context
3. Picks highest priority task where `passes: false`
4. Implements the task
5. Runs feedback loops (typecheck, tests, lint)
6. Commits if passing
7. Updates prd.json and progress.txt
8. Exits with `<promise>COMPLETE</promise>` when all done
