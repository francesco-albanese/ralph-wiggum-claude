# Subprocess-wrap agent CLIs, not Claude Agent SDK

Date: 21-05-2026

Ralph orchestrates AI coding agents that *will* include non-Anthropic agents (Codex in v1; Qwen-Code, Kimi, Aider, OpenCode deferred). The Claude Agent SDK is Anthropic-only — adopting it would either lock Ralph into a single vendor or force a hybrid code path (SDK for Claude, subprocess for everyone else) with divergent stream-event shapes, divergent usage parsing, and divergent error handling. The features the SDK appears to give for free (token/cost counting, stream forwarding, max iterations) are either available by parsing the CLI's stream-JSON (`claude -p --output-format stream-json`, `codex exec --json`) or are concerns Ralph already owns at the outer-loop level. We subprocess-wrap each agent CLI behind a single `AgentProvider` abstraction (lifted from sandcastle) — one code path, polyglot from day one.

## Considered options

- **Claude Agent SDK only** — rejected: kills Codex/Qwen/Kimi support.
- **Hybrid (SDK for Claude, subprocess for others)** — rejected: two code paths, divergent stream shapes, more surface area for bugs as agents evolve.
- **OpenAI SDK / direct API calls without a CLI** — rejected: would mean re-implementing Claude Code (tool execution, file edits, bash, permissions). Not in scope.
