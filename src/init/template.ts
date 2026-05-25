/**
 * Bundled `.ralph/prompt.md` template.
 *
 * Uses sandcastle-style `{{KEY}}` placeholders that `src/prompt/preprocessor`
 * substitutes per iteration (`{{BRANCH}}`, `{{TARGET_BRANCH}}`, plus any
 * project-specific user vars) and `` !`shell` `` expressions that re-expand
 * each iteration so the agent sees a fresh view of the world.
 *
 * Embedded as a TS string rather than a co-located `.md` because the build
 * (`tsc -p tsconfig.build.json`) only emits `dist/**.js` — a sibling `.md`
 * would not ship via `package.json#files: ["dist"]`. Inlining keeps install
 * simple at the cost of a slightly noisier source file; the template is
 * stable enough that the trade-off is worth it.
 */
export const BUNDLED_PROMPT_TEMPLATE = `<!-- tracker: beads -->
# Ralph iteration prompt

You are an autonomous coding agent. Work on one **bead** per iteration: read
the task, implement it, push commits, mark it closed.

Source branch: \`{{BRANCH}}\`
Target branch: \`{{TARGET_BRANCH}}\`

## Pre-filled context

Ready beads:

!\`bd ready --type task --limit 20\`

Active epics:

!\`bd list --type epic --status open\`

Recent commits on this branch:

!\`git log --oneline {{TARGET_BRANCH}}..HEAD\`

## 1. Find a task

\`bd ready --type task --limit 20\` is blocker-aware: it only returns tasks
with no unsatisfied dependencies and no \`in_progress\` status.

If empty, check for an active epic and confirm completion:

\`\`\`bash
EPIC_ID=$(bd list --type epic --status open --json | jq -r '.[0].id')
bd ready --parent "$EPIC_ID"
\`\`\`

If that is also empty, close the epic and stop:

\`\`\`bash
bd epic close-eligible
\`\`\`

Then output \`<promise>COMPLETE</promise>\` and stop.

## 2. Identify the active epic

\`\`\`bash
bd list --type epic --status open
\`\`\`

- **One epic**: use its ID as \`$EPIC_ID\`.
- **Multiple epics**: prefer the one whose children match the task you picked
  (\`bd show <task-id>\` shows \`parent\`). If ambiguous, pick the most
  recently updated epic and note the choice in the progress log.
- **Zero epics**: skip the progress-log steps for this iteration.

## 3. Prioritise

\`bd ready\` sorts by priority. When multiple tasks tie, break ties in this
order:

1. Architectural decisions and core abstractions
2. Integration points between modules
3. Unknown unknowns and spike work
4. Standard features and implementation
5. Polish, cleanup, and quick wins

Fail fast on risky work. Save easy wins for later.

## 4. Lock the task

\`\`\`bash
bd update <id> --claim
\`\`\`

Atomic — sets status to \`in_progress\` and assignee to you. Idempotent.

## 5. Read the task

\`\`\`bash
bd show <id>
\`\`\`

Read the description and acceptance criteria before writing any code.

## 6. Read the progress log

\`\`\`bash
bd comments "$EPIC_ID"
bd show "$EPIC_ID"
\`\`\`

Use this context to avoid redoing work, follow established patterns, and
build on previous decisions.

## 7. Implement

Implement the one task described in the issue. Keep changes small and
focused:

- One logical change per commit
- If a task feels too large, break it down into subtasks
- Prefer multiple small commits over one large commit

## 8. Feedback loops

Before committing, all available checks must pass. Discover available
checks from \`CLAUDE.md\`, the project's \`package.json\`, \`Makefile\`,
or \`pyproject.toml\`.

## 9. Git commit + push

Make a git commit of the completed work, then push to the remote. Only
commit work for a single task. The push is the finalisation step so work
is never left only locally.

## 10. Mark done

\`\`\`bash
bd close <id>
\`\`\`

## 11. Update progress log

\`\`\`bash
bd comment "$EPIC_ID" "# $(date -u +%Y-%m-%d)
- **Task completed**: <brief description> (<task-id>)
- **Files changed**: <list of files>
- **Decisions made**: <and why>
- **Blockers encountered**: <if any>
- **Architectural decisions**: <if any>
- **Notes for next iteration**: <context for the next agent>"
\`\`\`

## Stop condition

If, while implementing the feature, you notice that all work is complete
(\`bd ready --parent "$EPIC_ID"\` returns empty), run
\`bd epic close-eligible\` and output \`<promise>COMPLETE</promise>\`.

Otherwise end normally.
`;

export const BUNDLED_ENV_EXAMPLE = `# Ralph secrets — copy to .ralph/.env and fill in.
# This file IS committed; .ralph/.env is gitignored.

# WhatsApp notify (CallMeBot). Digits-only phone, no '+' or spaces.
WHATSAPP_PHONE=
WHATSAPP_APIKEY=

# Agent API keys (only set the ones you use).
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
`;
