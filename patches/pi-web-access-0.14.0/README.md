# `pi-web-access` 0.14.0 OpenAI auth patch

This directory records a one-hunk local modification to the published `pi-web-access@0.14.0` npm package
(MIT, © 2025 Nico Bailon), installed at `~/.pi/agent/npm/node_modules/pi-web-access`.

> **Superseded — do not apply.** The installed package has moved to `0.22.0`, which restructured OpenAI auth
> resolution: `AUTH_MODEL_CANDIDATES` is gone from `openai-search.ts` (only `xai-search.ts` still uses that pattern),
> `resolveOpenAIAuth` now threads the configured key and `OPENAI_API_KEY` through its own resolution path, and
> `patch --dry-run` against 0.22.0 fails its single hunk. This directory is kept as the record of what was changed and
> why. If the quota-binding behavior reappears, regenerate the diff and both manifests from the clean package of the
> version actually installed.

## Why

`resolveOpenAIAuth` in `openai-search.ts` resolves credentials in a fixed order: it first walks
`AUTH_MODEL_CANDIDATES` through pi's model registry, and only falls back to the configured
`openaiApiKey` or the `OPENAI_API_KEY` environment variable when that returns nothing. Because
`openai-codex` was the first candidate, every web search bound to the Codex subscription JWT and posted
to `chatgpt.com/backend-api/codex/responses`. Search then shared one quota with interactive coding use,
and a configured OpenAI API key was never reached — searches failed with
`usage_limit_reached` even though the key itself was healthy.

The package exposes no setting for this ordering, so the candidate list is edited directly.

## What changed

`openai-codex` is removed from `AUTH_MODEL_CANDIDATES`. Auth resolution now finds either a registered
`openai` provider model or the configured key, and requests go to `api.openai.com/v1/responses`.

`isCodexJwt` and the `useCodexEndpoint` branch are deliberately left in place, so a Codex-shaped
credential supplied on purpose still routes to the Codex endpoint.

## Contents

- `openai-codex-auth.patch` — the change, as a `-p1` unified diff against `openai-search.ts`.
- `baseline.sha256` — checksum of `openai-search.ts` in the clean 0.14.0 package.
- `patched.sha256` — checksum expected after applying the patch.

## Reapplying

An `npm` reinstall or package upgrade restores the upstream file. To reapply:

```sh
cd ~/.pi/agent/npm/node_modules/pi-web-access
shasum -a 256 -c <(sed 's|openai-search.ts|./openai-search.ts|' \
  /path/to/patches/pi-web-access-0.14.0/baseline.sha256)
patch -p1 < /path/to/patches/pi-web-access-0.14.0/openai-codex-auth.patch
```

Do not apply this patch to another `pi-web-access` version without regenerating the diff and the
checksum manifests from that version's clean package.
