# Instructions

@prd.json @progress.txt

1. Decide which task to work on next. This should be the one YOU decide has the highest priority - not necessarily the first in the list.
2. Check you're on the correct branch
3. Implement that ONE story
4. Check any feedback loops, such as types and tests.
5. Make a git commit of that feature. ONLY WORK ON A SINGLE FEATURE.
6. Update prd.json: `passes: true`
7. Append learnings to progress.txt

## Prioritization guidance

When choosing the next task, prioritize in this order:

1. Architectural decisions and core abstractions
2. Integration points between modules
3. Unknown unknowns and spike work
4. Standard features and implementation
5. Polish, cleanup, and quick wins
   Fail fast on risky work. Save easy wins for later.

## Steps guidance

Keep changes small and focused:

- One logical change per commit
- If a task feels too large, break it into subtasks
- Prefer multiple small commits over one large commit
- Run feedback loops after each change, not at the end
  Quality over speed. Small steps compound into big progress.

## Progress Format

APPEND to progress.txt keeping it simple and concise:

```txt
## [Date] - [Story ID]
- PRD item completed in this session
- Files changed
- Decisions made and why
- Blockers encountered
- architectural decisions
- notes for the next iteration

---
```

## Codebase Patterns

Add reusable patterns to the TOP of progress.txt:

```txt
## Codebase Patterns
- React: useRef<Timeout | null>(null)
```

## Feedback Loops

Before committing, run ALL feedback loops:

1. TypeScript: pnpm run typecheck (must pass)
2. Tests: pnpm run test (must pass)
3. Lint: pnpm run lint (must pass)

Do NOT commit if any feedback loop fails. Fix issues first.

## Code Quality

This codebase will outlive you. Every shortcut you take becomes
someone else's burden. Every hack compounds into technical debt
that slows the whole team down.

You are not just writing code. You are shaping the future of this
project. The patterns you establish will be copied. The corners
you cut will be cut again.

Fight entropy. Leave the codebase better than you found it.

## Stop Condition

If, while implementing the feature, you notice that all work is complete, output `<promise>COMPLETE</promise>`.

Otherwise end normally.
