# Dogfood install via pnpm link, no public npm package

Date: 27-05-2026

Ralph is a personal tool — it exists to drive my own AFK coding loops, not to be a product. Publishing to npm adds release hygiene (semver discipline, changelog, deprecation policy, public bug surface) that I'd be on the hook for without any matching upside. The install model is `pnpm link --global` from this repo: one clone, one `pnpm build`, one `pnpm link --global`, and `ralph` is on `$PATH` for any project I `cd` into. Source edits are picked up by re-running `pnpm build` — `bin` points to `dist/cli.js`, so a stale `dist/` runs old code, but the linked symlink itself never moves. `package.json` stays `"private": true` to make the intent obvious to any future reader (and to me when I forget). When/if Ralph stops being a personal tool, this ADR gets superseded.

## Considered options

- **Publish to npm under `@franco-albanese/ralph`** — rejected for v1: release hygiene cost without a user base to justify it.
- **`pnpm add -g <git+ssh://...>`** — rejected: re-install required after every change; loses the edit-rebuild-reuse loop.
- **Manual `~/.local/bin/ralph` symlink** — rejected: same end state as `pnpm link --global` but bypasses pnpm's awareness of the package.
