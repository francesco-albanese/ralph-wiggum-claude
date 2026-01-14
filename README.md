# Ralph Wiggum Claude

Reusable bash scripts for Ralph Wiggum approach - autonomous AI coding loops with Claude Code.

## What is Ralph?

Ralph runs Claude Code in a loop, letting it work autonomously on tasks. Two modes:
- **HITL (ralph-once)**: Single iteration, watch and intervene
- **AFK (afk-ralph)**: Loop with max iterations, unsupervised

## Install Globally

```bash
# Clone once
git clone git@github.com:francesco-albanese/ralph-wiggum-claude.git ~/.ralph-wiggum

# Ensure ~/.local/bin exists and is in PATH
mkdir -p ~/.local/bin
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc

# Symlink scripts
ln -s ~/.ralph-wiggum/ralph-once.sh ~/.local/bin/ralph-once
ln -s ~/.ralph-wiggum/afk-ralph.sh ~/.local/bin/afk-ralph

# Reload shell
source ~/.zshrc
```

Update scripts:
```bash
cd ~/.ralph-wiggum && git pull
```

## Usage

### Setup (per project)

```bash
cd ~/any-project

# Create ralph directory
mkdir -p scripts/ralph

# Copy templates
cp ~/.ralph-wiggum/templates/* scripts/ralph/

# Edit prd.json with your tasks
# Edit prompt.md if needed
```

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

```
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
