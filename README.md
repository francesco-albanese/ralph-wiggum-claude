# Ralph Wiggum Claude

Reusable bash scripts for the Ralph Wiggum approach — autonomous AI coding loops with Claude Code.

## What is Ralph?

Ralph runs Claude Code in a loop, letting it work autonomously on tasks from a tracker. Two modes:
- **HITL (ralph-once)**: Single iteration, watch and intervene
- **AFK (afk-ralph)**: Loop with max iterations, unsupervised

## Backends

Ralph supports two issue trackers. The choice is made per skill invocation and baked into the local `scripts/ralph/prompt.md`:

- **GitHub issues** (default) — needs `gh`. Tasks are issues with labels (`task`, `in-progress`, `done`); the progress log is a dedicated `progress-log` issue.
- **beads (`bd`)** — needs `bd` plus an initialised `.beads/` database. PRD is an epic, slices are child tasks. Progress log = `bd comment` stream on the epic (iterations) + `bd note` notes field (evergreen Codebase Patterns). Dependencies are native (`--deps blocks:…`), task pickup uses `bd ready`, locking uses `bd update --claim`.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- `jq` installed
- One of:
  - [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated (GitHub backend), **or**
  - [beads](https://github.com/prathyushpv/beads) (`bd`) installed (beads backend)

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

Asks for the backend (GitHub or beads), creates `scripts/ralph/`, and copies the matching template into `scripts/ralph/prompt.md`.

**Option 2: Manual**

```bash
cd ~/any-project
mkdir -p scripts/ralph
# GitHub:
cp ~/Documents/Development/ralph-wiggum-claude/templates/prompt-github.md scripts/ralph/prompt.md
# or beads:
cp ~/Documents/Development/ralph-wiggum-claude/templates/prompt-beads.md scripts/ralph/prompt.md
```

### Recommended workflow

1. `/write-a-prd` — create a PRD (GitHub issue or beads epic, per your choice)
2. `/prd-to-issues` — break the PRD into task issues (GitHub) or child tasks with `--deps` (beads)
3. `/ralph-bootstrap` — copy the matching prompt template into the project
4. `ralph-once` or `afk-ralph` — run autonomous coding loops

Each skill asks for the backend at the start — pick the same one each time, but nothing enforces consistency, so you're free to change your mind.

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

### Milestone scoping

Scope agents to a specific milestone to prevent collisions when running multiple loops. The wrapper scripts detect the backend from the `<!-- tracker: ... -->` marker in `prompt.md` and inject the matching filter text.

```bash
# Scope to a milestone (works in both backends)
afk-ralph 10 --milestone "Sprint 3"
ralph-once --milestone "Sprint 3"

# Add extra instructions
afk-ralph 10 --instructions "Focus on backend tasks only"

# Combine both
afk-ralph 10 --milestone "Backend v2" --instructions "Skip legacy/ files"

# Run multiple agents on different milestones
afk-ralph 10 --milestone "Backend v2" &
afk-ralph 10 --milestone "Frontend v2" &
```

- GitHub: uses `--milestone "Sprint 3"` on `gh issue list`.
- Beads: slugifies the name and uses `--label milestone:sprint-3` on `bd ready` / `bd create`.

## Files Structure

```text
scripts/ralph/
└── prompt.md      # Instructions for Claude (tracker-specific)
```

## How It Works

Each iteration:

### GitHub backend
1. Queries GitHub issues with `task` label (excluding `done` and `in-progress`)
2. Checks dependencies and picks highest priority task
3. Locks the task with `in-progress` label
4. Reads progress log (separate issue) for prior context
5. Implements the task
6. Runs feedback loops (discovers checks from project config)
7. Commits if passing
8. Marks task done, swaps labels, closes issue
9. Updates progress log issue with iteration summary
10. Exits with `<promise>COMPLETE</promise>` when the task list is empty

### Beads backend
1. Runs `bd ready --type task` (blocker-aware — already filters out blocked and in-progress)
2. Ties break by the prompt's prioritisation ladder
3. Locks the task atomically via `bd update <id> --claim`
4. Reads progress log on the epic: `bd comments <epic-id>` + `bd show <epic-id>` (notes field)
5. Implements the task
6. Runs feedback loops
7. Commits if passing
8. Closes the task with `bd close <id>`
9. Appends iteration summary via `bd comment <epic-id>`; appends any new patterns via `bd note <epic-id>`
10. When `bd ready --parent <epic-id>` is empty, runs `bd epic close-eligible` and exits with `<promise>COMPLETE</promise>`
