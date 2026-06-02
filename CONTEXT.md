# Ralph

A TypeScript CLI that runs an AI coding agent in a loop (the **Ralph loop**), implementing **beads** tasks one **iteration** at a time inside a **worktree**, and shipping the result as one **PR** per **invocation** — AFK-friendly, with a rich WhatsApp notification at the end.

## Language

### Core concepts

**Ralph**:
The CLI binary and the surrounding TypeScript project. Replaces the old bash scripts (`afk-ralph.sh`, `ralph-once.sh`).
_Avoid_: "the script", "afk-ralph", "ralph-wiggum"

**Agent**:
The AI coding tool invoked inside an **iteration** (Claude Code or Codex in v1).
_Avoid_: "Claude", "the LLM", "the bot"

**Agent provider**:
A pluggable shim that knows how to subprocess-spawn a specific **agent** CLI, parse its stream-JSON, and extract token usage. Lifted from sandcastle.
_Avoid_: "agent adapter", "provider" in isolation

**Iteration**:
A single invocation of the **agent** against the **prompt**, in a fresh agent context, producing zero or one bead-closure + zero or more commits.
_Avoid_: "loop", "run" (ambiguous with **invocation**), "cycle"

**Invocation** (or **run session**):
One `ralph` CLI call. Contains up to N **iterations** (default 10). Produces one **branch** and one **PR**.
_Avoid_: "run" alone, "session" alone

**Worker**:
One parallel Ralph lane. Each **worker** owns one **invocation**, one **source branch**, one **worktree**, and one **PR**.
_Avoid_: "workstream", "lane" in user-facing docs

**Fixed worker swarm**:
A swarm where Ralph starts exactly N **workers** and each **worker** loops independently until **no-claim exit**, **stall**, crash, or interruption. Ralph does not dynamically create replacement workers after individual **beads** complete.
_Avoid_: "worker pool", "dynamic pool"

**Bead**:
A task in the local `bd` database. The unit of work an **iteration** picks up via `bd ready`.
_Avoid_: "task" (overloaded), "issue", "ticket"

**Claimed bead**:
A **bead** that Ralph assigns to a **worker** before launching an **agent** **iteration** in swarm mode. The **agent** must work only on the **claimed bead**.
_Avoid_: "selected task", "reserved issue"

**Active epic**:
The open `bd` epic that owns the **beads** Ralph is working through. Hosts the per-iteration progress log (comments) and evergreen Codebase Patterns (notes).
_Avoid_: "PRD", "milestone", "story"

**Completion signal**:
The string `<promise>COMPLETE</promise>` emitted by the **agent** to signal "no more beads ready, stop the **invocation**." Overridable per run via `--complete-signal`.
_Avoid_: "done flag", "exit signal", "promise"

**No-claim exit**:
The worker terminal path in swarm mode when Ralph cannot claim a ready **bead** for that **worker**. The **worker** exits without launching an **agent** **iteration**.
_Avoid_: "empty completion", "idle run"

**Stall**:
The terminal state when `--max-iter` is reached without the **completion signal**. The **PR** stays draft; WhatsApp warns.
_Avoid_: "fail", "timeout" (different concept — see **iteration timeout**)

**Swarm outcome**:
The aggregate terminal state for a set of **workers**. It is the worst **worker** outcome: all complete means COMPLETE; any stalled worker means STALLED unless another worker crashed or was interrupted; any crashed worker means FAILED; any interrupted worker means INTERRUPTED.
_Avoid_: "swarm status", "overall result"

**Iteration timeout**:
The hard wall-clock limit on a single **iteration** (default 30 min). Hitting it kills the agent subprocess and moves to the next iteration without exiting the **invocation**.
_Avoid_: "agent timeout", "deadline"

### Workspace

**Worktree**:
A git worktree created under `.ralph/worktrees/` on the host. The **agent** runs with this as its cwd. Lifted from sandcastle.
_Avoid_: "workspace", "clone", "checkout"

**Branch strategy**:
How **iteration** commits relate to the host's branches. Three modes from sandcastle: `head`, `merge-to-head`, `branch`. Default for Ralph: `branch` (commits land on the user-supplied `--branch` name).
_Avoid_: "worktree mode"

**Source branch**:
The branch the **agent** commits to during the **invocation** — derived from `--branch`.
_Avoid_: "working branch", "agent branch"

**Worker source branch**:
A **source branch** derived from the parent **source branch** for one **worker** by appending a deterministic worker suffix such as `-w1`.
_Avoid_: "child branch", "sub-branch"

**Target branch**:
The host's active branch at `ralph` invocation time — the merge target for the **PR**.
_Avoid_: "base branch", "main"

### Prompt

**Prompt**:
The text the **agent** reads on every **iteration**, loaded from `.ralph/prompt.md`. Same content per invocation; re-expanded each iteration.
_Avoid_: "system prompt", "instructions"

**Pre-filled context**:
The top section of the **prompt** filled by **shell expressions** each iteration: `bd ready`, `bd list --type epic`, `bd comments`, `bd memories`, `git log <base>..HEAD`, `.claude/rules/*`. Keeps the agent's context fresh without re-reading static instructions.
_Avoid_: "context block", "preamble"

**Shell expression**:
A `` !`command` `` marker in the **prompt** that runs the command and inlines its stdout. Lifted from sandcastle.
_Avoid_: "inline command", "context command"

### Orchestration

**Quality gate** (QG):
A single agent invocation that runs at **completion signal** time, after the last iteration. Reviews the full PR diff, auto-fixes high-severity issues, files beads for ambiguous follow-ups, and writes the **PR** title + 2-sentence body. Uses the user's existing `/quality-gate` skill (which wraps the `code-quality-verifier` subagent).
_Avoid_: "review pass", "final check"

**WhatsApp notify**:
The rich plain-text message sent via CallMeBot at COMPLETE or stall. Includes status, project, branch, PR URL, iteration/time, tasks (done + blocked), tokens + cost, brief task summary, QG findings line.
_Avoid_: "notification", "ping"

**Swarm WhatsApp message**:
A single aggregate **WhatsApp message** sent after all **workers** finish, listing the **swarm outcome**, worker count, worker PR URLs, and any stalled or failed workers.
_Avoid_: "per-worker notifications", "message storm"

**State file**:
A JSON file under `.ralph/state/<pid>.json` describing a running **invocation**: branch, started-at, current iteration, current bead, cumulative cost. Read by `ralph status`; deleted on clean exit.
_Avoid_: "PID file" (the PID is one field; the state is more)

**Detached mode**:
Running `ralph run --detach`: spawns the **invocation** as a daemonised child, returns immediately, writes the **state file**. Monitored via `ralph status` / `ralph tail`; stopped via `ralph stop`.
_Avoid_: "background", "nohup mode"

## Relationships

- A **Ralph** **invocation** runs N **iterations** until **completion signal** or **stall** or **iteration timeout** exhaustion.
- Each **iteration** spawns one fresh **agent** process via an **agent provider**, with the **prompt** re-expanded for that iteration.
- Each **worker** keeps the same fresh-per-**iteration** semantics; it does not keep a persistent **agent** thread between **iterations**.
- In a single-worker **invocation**, the **agent** picks one **bead**, implements it, and pushes one or more commits to the **source branch**.
- In a swarm, Ralph claims one **bead** for a **worker** before launching that worker's **agent** **iteration**; the **agent** works only on the **claimed bead**.
- In a swarm, a **worker** uses **no-claim exit** when Ralph cannot claim a ready **bead** for it.
- A swarm is a **fixed worker swarm**: Ralph starts exactly N **workers**, and each **worker** loops independently until it reaches a terminal state.
- In a swarm, each **worker** uses a deterministic **worker source branch** such as `feat/example-w1`.
- One **invocation** → one **source branch** → one **PR**. Draft after iteration 1, marked ready after **QG** finishes at COMPLETE.
- The **QG** is a separate agent invocation (fresh context) — it reviews the full PR diff, not just one iteration's diff.
- **Detached mode** writes a **state file**; `ralph status` reads it; `ralph stop` sends SIGTERM to the PID inside.
- The **prompt**'s **pre-filled context** is regenerated each iteration via **shell expressions** — keeps the agent's view of the world current without re-reading static instructions.
- v1 is **beads-only**. GitHub Issues support from the bash era is dropped.

## Flagged ambiguities

- **"Task"** — overloaded across (a) a beads bead, (b) the `Task` tool used to spawn subagents, (c) a generic todo item. Use **bead** for the first, "subagent" or "Task tool" for the second, avoid the third altogether.
- **"Run"** — can mean the JS function, an **invocation**, or an **iteration**. Use **invocation** for one CLI call and **iteration** for one agent call. "Run" alone is banned.
- **"Provider"** — overloaded between **agent provider** and (deferred) sandbox provider. Always qualify.
- **"Done"** — could mean a bead closed, an iteration finished, or the whole invocation completed. Use "closed" for beads, "iteration finished", or "**completion signal**" / "**stall**" for invocation exit.
- **"Promise"** — the **completion signal** uses `<promise>...</promise>` XML. Don't use "promise" to mean a JS Promise in Ralph prose.
- **"Notify"** vs **"Notification"** — the host action is **WhatsApp notify**; the message itself is the "WhatsApp message". Don't say "the notification" when you mean the message body.
- **"Worktree"** vs **"branch"** — a **worktree** is the on-disk checkout; the **source branch** is the git reference its commits accumulate on. Both exist for one **invocation**.

## Example dialogue

> **Dev**: "What happens if I Ctrl-C ralph mid-iteration?"

> **Domain expert**: "First Ctrl-C sends SIGTERM to the agent subprocess and waits up to 30s for the stream to drain. Whatever's already committed and pushed to the **source branch** stays on the **PR** (which is still draft because we never hit the **completion signal**). The **state file** is removed. Second Ctrl-C within 5s sends SIGKILL — same end state, just abrupt."

> **Dev**: "Do I need to worry about a second `ralph` invocation stepping on the first?"

> **Domain expert**: "Different invocations need different `--branch` names. Each one writes its own **state file** under `.ralph/state/<pid>.json`. They can both run on the host, both have their own **worktree**, both their own **PR**. `bd ready` is blocker-aware, so they won't claim the same **bead**."

> **Dev**: "Why isn't the **quality gate** running per iteration?"

> **Domain expert**: "Cost and bias. Per-iteration QG would be ~N extra agent invocations per **invocation**. And per-iteration review misses cross-iteration drift — e.g., iteration 2 contradicts iteration 4's design. The single end-of-run QG sees the full PR diff and can spot inconsistencies. Caveat: a bad iteration 1 might shape the rest of the run before QG catches it — we accept that risk for v1."
