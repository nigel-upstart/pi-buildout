# `pi-web-access` 0.14.0 OpenAI auth patch — removed

The patch, its README, and its checksum manifests were deleted from this repository. Only this record remains. Nothing
here is applied by any installer; `scripts/install-extensions.sh` never consulted this directory.

## Reference

Recover the deleted files from git history:

```sh
git show da406716d486f49128f7ea067110da5890dd5d85 -- patches/pi-web-access-0.14.0
git checkout da406716d486f49128f7ea067110da5890dd5d85 -- patches/pi-web-access-0.14.0
```

- Commit holding the removed content: `da406716d486f49128f7ea067110da5890dd5d85`
- Target file: `openai-search.ts` in the published `pi-web-access@0.14.0` npm package
- `openai-search.ts` SHA-256, clean 0.14.0: `a0bcbc8d942eb454e00b2d337452758a6484b08200eaf41697129a21581b43e2`
- `openai-search.ts` SHA-256, after the patch: `d6bc9fe2f6ec78e96ddd0829df93860c745d1bb031362a6d2116534912376db8`
- Upstream: <https://github.com/nicobailon/pi-web-access>, MIT, © 2025 Nico Bailon

## What the patch was attempting to do

Force web search onto a configured OpenAI API key instead of the Codex subscription credential.

`resolveOpenAIAuth` resolved credentials in a fixed order: it walked `AUTH_MODEL_CANDIDATES` through pi's model registry
first, and only fell back to the configured `openaiApiKey` or the `OPENAI_API_KEY` environment variable when that
returned nothing. Because `openai-codex` was the first candidate, every web search bound to the Codex subscription JWT
and posted to `chatgpt.com/backend-api/codex/responses`. Search therefore shared one quota with interactive coding use,
and a healthy configured API key was never reached — searches failed with `usage_limit_reached`.

The package exposed no setting for that ordering, so the single hunk deleted the `openai-codex` entry from
`AUTH_MODEL_CANDIDATES`, leaving the `openai` provider entry. Auth resolution then found either a registered `openai`
model or the configured key, and requests went to `api.openai.com/v1/responses`.

`isCodexJwt` and the `useCodexEndpoint` branch were deliberately left intact, so a Codex-shaped credential supplied on
purpose still routed to the Codex endpoint.

## Why it was removed

Superseded by the installed package moving to `0.22.0`:

- `AUTH_MODEL_CANDIDATES` no longer exists in `openai-search.ts`; only `xai-search.ts` still uses that pattern, for Grok
  models.
- `resolveOpenAIAuth` was restructured and now threads the configured `openaiApiKey` and `OPENAI_API_KEY` through its own
  resolution path rather than reaching them only as a last fallback.
- `patch --dry-run -p1` against the 0.22.0 package fails its single hunk, and the recorded baseline checksum no longer
  matches any shipped file.

Whether 0.22.0 still prefers a Codex credential when both are available was not re-verified; `SEARCH_PROVIDERS` there is
still `["openai-codex", "openai"]`. If the quota-binding symptom reappears, treat this as background only and derive a
fresh patch and manifests from the clean package of the version actually installed. Do not resurrect this diff.
