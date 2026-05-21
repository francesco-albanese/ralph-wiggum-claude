# One branch and one PR per Ralph invocation

Date: 21-05-2026

A single `ralph` invocation produces one named source branch (with semantic prefix, supplied via `--branch`) and one PR — not one PR per bead, and not direct commits to the host's active branch. The PR is created as draft after iteration 1's first push, accumulates commits across iterations, and is marked ready by the quality-gate agent at completion. This gives one WhatsApp notification per invocation with one PR URL, keeps partial work inspectable on GitHub if the run crashes or stalls, and supports parallel invocations on different milestones without coordination. Per-bead PRs were rejected because N PRs per AFK run is hostile to review and produces N notifications; head-strategy (direct commits to current branch) was rejected because the user wants a PR link in the WhatsApp message and a clean separation between Ralph's work and the host's main branch.

## Considered options

- **One PR per bead** — rejected: N notifications per run, N PRs to triage.
- **Head strategy (direct commits, no PR)** — rejected: no PR URL for WhatsApp; the user explicitly asked for PR linkage.
- **Merge-to-head (worktree + temp branch + auto-merge)** — rejected: no PR opened, same loss-of-link problem as head.
