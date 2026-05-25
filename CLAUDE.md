# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
pnpm install         # install dependencies
pnpm test            # vitest (run once)
pnpm test:watch      # vitest watch mode
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome check
pnpm lint:fix        # biome check --write
pnpm build           # tsc -> dist/
```

## Architecture Overview

Ralph is a TypeScript CLI that drives an AI coding agent in an iteration
loop, opens one PR per invocation, and notifies via WhatsApp at the end.
Source lives in `src/`; tests live in `src/*.test.ts` and `tests/`.
Bundled templates that need to ship in `dist/` are embedded as TS string
constants (see `src/init/template.ts`), since `package.json#files`
only includes `dist/`.

## Conventions & Patterns

- ESM, Node >= 20, pnpm. Always use `pnpm` (never `npm` / `yarn`).
- Biome for lint + format (`pnpm lint`, `pnpm lint:fix`).
- TypeScript strict mode; no `any`; prefer `type` over `interface`.
- Vertical-slice tests via vitest — favour pure functions + thin IO
  shells so tests don't need to mock subprocesses or prompts.
- Issue tracker: beads (`bd`) — see the section above. No TodoWrite, no
  markdown TODOs.
