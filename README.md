# Ralph

TypeScript CLI that drives an AI coding agent (Claude Code or Codex) in an iteration loop against [beads](https://github.com/prathyushpv/beads) tasks, opens one draft PR per invocation, runs a quality-gate pass at completion, and pings WhatsApp when the run ends.

Personal tool — not on npm. Install via `pnpm link --global` from a local clone (see below).

## Prerequisites

- Node `>=20.12`, pnpm
- `git`
- `bd` ([beads](https://github.com/prathyushpv/beads)) installed and initialised in any project you intend to run Ralph against
- One of: `claude` CLI or `codex` CLI (whichever agent you pick via `--agent`)
- Optional: [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) apikey for WhatsApp notifications

## Install (dogfood)

```bash
git clone git@github.com:francesco-albanese/ralph-wiggum-claude.git
cd ralph-wiggum-claude
pnpm install
pnpm build
pnpm link --global
```

`ralph` is now on `$PATH` from any cwd.

After editing Ralph's source, re-run `pnpm build` — the linked binary points at `dist/cli.js`, so stale `dist/` means stale behaviour.

## Setup in a project

```bash
cd ~/some-project
ralph init
```

The wizard scaffolds `.ralph/` (prompt template, config, env example, gitignore entries). Edit `.ralph/prompt.md` and `.ralph/.env` afterwards.

## Usage

```bash
# Run an invocation in the foreground
ralph run --branch feat/your-slice

# Detach — daemonises, returns immediately
ralph run --branch feat/your-slice --detach

# Inspect detached runs
ralph status
ralph tail [<pid>]
ralph stop [<pid>]
```

Common flags on `ralph run`:

- `--agent claude|codex` (default from `.ralph/ralph.config.json`)
- `--max-iter <n>` (default 10)
- `--timeout-min <n>` per-iteration wall-clock cap (default 30)
- `--complete-signal <regex>` override the default `<promise>COMPLETE</promise>`
- `--base <ref>` PR target branch (defaults to the host's current branch)

## Configuration

- `.ralph/ralph.config.json` — committed: default agent, model, max-iter, completion signal, etc.
- `.ralph/.env` — gitignored: `CALLMEBOT_PHONE`, `CALLMEBOT_APIKEY`, agent API keys.
- `.ralph/state/` — gitignored: per-invocation state files (one per running PID).
- `.ralph/logs/` — gitignored: structured JSONL logs.
- `.ralph/worktrees/` — gitignored: per-invocation git worktrees.

CLI flags override `.ralph/ralph.config.json`.

## How it works

Each `ralph run` produces **one source branch and one PR** (see [ADR 0002](docs/adr/0002-one-branch-one-pr-per-invocation.md)). Inside that invocation:

1. A git worktree is created under `.ralph/worktrees/`.
2. Per iteration: the agent CLI is subprocess-spawned (see [ADR 0001](docs/adr/0001-subprocess-wrap-agent-clis-not-claude-agent-sdk.md)) inside the worktree with the expanded prompt, its stream-JSON is parsed into normalised events, and tokens + cost are accumulated.
3. After iteration 1's first push, a **draft PR** is opened against the host's current branch.
4. Iterations continue until the agent emits the completion signal, the per-iteration timeout fires repeatedly enough to stall, or `--max-iter` is hit.
5. At completion, the **quality gate** runs once on the full PR diff — auto-fixes high-severity findings, files follow-up beads, writes the PR title and 2-sentence body, marks the PR ready.
6. A WhatsApp message is sent (best-effort) with status, PR URL, iteration count, cost, and a brief summary.

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — domain glossary
- [`docs/adr/`](docs/adr/) — architectural decision records
