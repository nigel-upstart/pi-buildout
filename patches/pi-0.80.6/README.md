# pi 0.80.6 `/skills` patch

This directory contains the patched runtime files for pi `0.80.6`. The patch changes skills from automatically loaded prompt context to an opt-in catalog with explicit activation.

## Behavior

- Discovered skills form a catalog but are not injected into the system prompt by default.
- Active skills can be configured globally in `~/.pi/agent/skills.json` or per repository in `~/.pi/agent/repo-skills.json`.
- `/skills active`, `list`, `search`, `add`, `remove`, and `reload` are available interactively.
- `pi skills ...` provides the corresponding CLI operations.
- `--no-skills` suppresses global and repository skills while preserving explicit `--skill` paths.
- Repository keys prefer `upstream`, then `origin`, then other remotes, with a local-path fallback.

The runtime snapshot is intentionally versioned because it patches installed `dist/*.js` files rather than pi source. Do not apply it to another pi version without reviewing the changes.
