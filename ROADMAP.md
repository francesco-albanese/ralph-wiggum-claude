# Ralph CLI — Roadmap

Tracking features deferred out of v1 during the grill-me session on 2026-05-20. Run a separate `/grill-with-docs` session on each before implementing.

## v1 (in scope — being designed now)

1. Core `ralph` CLI (TypeScript, subprocess-wraps agent CLIs)
2. Worktree + branch strategy (head / merge-to-head / branch) — lifted from sandcastle
3. Claude Code + Codex agent providers
4. WhatsApp rich notify with PR link + token/cost summary
5. Quality-gate hook (one invocation at COMPLETE on full PR diff; review + auto-fix + file beads for ambiguous)
6. Clean kill/stop (Ctrl-C handling)
7. Auto-create `prompt.md` via interactive wizard if missing
8. Basic tests (vitest)
9. Beads-only tracker support
10. One named branch + draft PR per `ralph` invocation; PR ready at COMPLETE
11. Explicit `--branch` flag with semantic naming (feat/fix/chore/etc.)

## v2+ (deferred — grill separately before building)

### Langfuse observability (opt-in)

**What:** Per-project Langfuse traces of every iteration's tokens, cost, agent output, tool calls. Opt-in via env var or CLI flag; default off.

**Why deferred:** Single-user value; nice-to-have, not blocking. Easier to design once v1 has stable stream-event shapes.

**Open questions to grill:**
- Trace granularity: one trace per `ralph` invocation, or one per iteration?
- Auto-create Langfuse project per repo, or single shared project tagged by repo?
- Where does the Langfuse SDK live in the architecture — a `StreamExporter` subscribed to `onAgentStreamEvent`?
- What's the "agent slop" metric exactly? Token spend vs. accepted-commit ratio? Reviewer override count?

### Swarm mode (parallel agents)

**What:** `ralph --swarm N` spawns N worktrees in parallel, each agent grabs a different unblocked `bd ready` task.

**Why deferred:** Concurrency bugs around task claiming, branch naming, and PR coordination. Not worth it until single-agent is dialled in and you actually feel the bottleneck.

**Open questions to grill:**
- One PR per swarm worker, or one PR aggregating all swarm work?
- Branch naming for N workers (numbered suffix, or N flags)?
- How does WhatsApp message change with N workers (N messages or 1 aggregate)?
- Claim coordination: race condition on `bd update --claim` between workers?
- What happens when one worker stalls and others COMPLETE?

### Extra agent providers (Qwen-Code, Kimi, Aider, OpenCode)

**What:** Add `qwenCode()`, `kimi()`, `aider()`, `openCode()` to `AgentProvider`. Subprocess-wrap their CLIs.

**Why deferred:** Claude + Codex covers the immediate "swap for cheaper" need. Other agents have less stable stream-JSON shapes and require per-agent parsing investment.

**Open questions to grill:**
- Which agents matter most after Claude+Codex?
- How do we discover and pin their stream-JSON formats?
- Do they support `--dangerously-skip-permissions` equivalents? (Codex: `--dangerously-bypass-approvals-and-sandbox`; others: unknown.)
- Cost calculation — each agent has its own pricing model and usage event shape.

### npm publishing + semantic-release CI

**What:** Publish `@franco-albanese/ralph` to npm via automated semantic-release CI. Until then v1 is consumed via `pnpm link` or git install.

**Why deferred:** Resolved at PRD time (2026-05-21). v1 ships the CLI as a local build; publishing needs proper CI, conventional-commits enforcement, version automation, changelog generation, and provenance attestation. Out of scope for the initial implementation push.

**Open questions to grill:**
- semantic-release vs changesets vs release-please?
- GitHub Actions workflow shape (matrix node versions, OS coverage)?
- Provenance attestation (`--provenance` flag) — required from day 1?
- Dual-publish (scoped + unscoped alias `ralph-wiggum`) or scoped only?
- Pre-release channel (`@next`) for bleeding-edge consumers?

### Docker/Podman sandbox providers (beyond noSandbox)

**What:** Run the agent inside a container. Lifted from sandcastle's `DockerLifecycle` / `PodmanLifecycle`.

**Why deferred:** You can already run `docker sandbox run` via your current bash. The agent-orchestrator doesn't need its own container layer in v1 unless you want full filesystem isolation.

**Open questions to grill:**
- Bind-mount vs isolated (sandcastle distinction)?
- Does the host need the project's runtime installed (Node / Python / etc.), or does it all live in the container?
- Image-build UX: `ralph docker build-image` like sandcastle, or a config file?
- What's the actual threat model — protect against rogue agent commands on the host, or just reproducibility?
