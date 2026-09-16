# `extensions/otel`

A vendored, `pi-buildout`-owned fork of [`pi-otel`](https://github.com/NikiforovAll/pi-otel), imported at revision
`bf00f530d3667375a5317a0f425d0918e6cfac7e` (release `0.3.0`, Apache-2.0).

## Status

This layer imports the source and gives it a reproducible build, test, and CI path. It is **not installed or activated**
yet: `scripts/install-extensions.sh` still does not ship it, and `upstart-dotfiles` still consumes the published
`npm:pi-otel@0.3.0`. See [issue #45](https://github.com/zew1me/pi-buildout/issues/45) for the ownership decision
and the remaining work.

## Why it is vendored rather than reimplemented

`pi-otel` is the only Pi telemetry extension that implements the OTel GenAI span model directly (`invoke_agent pi` /
`chat {model}` / `execute_tool {tool}` with `gen_ai.operation.name`, spec `SpanKind`, normalized `gen_ai.provider.name`,
token usage, and cost). Reimplementing that span tree would discard the artifact's main value, so the fork keeps upstream
behavior and evolves it under our own tests.

## Layout and toolchain

The upstream `src/` and `test/` layout is preserved deliberately so future upstream revisions stay diffable. The fork
carries its own `package.json`, `tsconfig.json`, and dependency lockfile, and the root project's Prettier, ESLint, knip,
and `tsc` runs exclude this directory. Reformatting the vendored source to match root style would destroy that
diffability for no functional gain.

```bash
cd extensions/otel
npm ci
npm run typecheck
npm test          # builds, then runs the upstream node:test suite
```

CI runs the same commands in the `otel-extension` job of `.github/workflows/check.yml`.

## Configuration

Upstream settings are unchanged. This fork adds one:

| Setting | Env var | Default | Range |
| --- | --- | --- | --- |
| `otel.maxAttributeBytes` | `PI_OTEL_MAX_ATTRIBUTE_BYTES` | `61440` (60 KiB) | `1` – `67108864` (64 MiB) |

```jsonc
{
  "otel": {
    "captureContent": "full",
    "maxAttributeBytes": 1048576
  }
}
```

The cap applies to every content attribute this extension builds — `pi.user_prompt`, `gen_ai.input.messages`,
`gen_ai.output.messages`, `gen_ai.tool.call.arguments` / `pi.tool.input`, and `gen_ai.tool.call.result` /
`pi.tool.output`. It is applied where those values are produced, which is the only place a cap can be *raised*:
`OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` configures the SDK's own `spanLimits`, and that limit can only truncate a value
further (it defaults to unlimited and is character-based, not byte-based). Setting it can therefore never lift this
extension's clamp — hence a dedicated setting.

The default preserves upstream behavior exactly: without this setting, capture is still clipped at 60 KiB. Raising it is
what allows full-fidelity capture to actually leave the machine. A value outside the supported range falls back to the
default rather than disabling capture or exporting an unbounded attribute.

## Owned changes so far

- `otel.maxAttributeBytes` replaces upstream's module-private `MAX_ATTR_BYTES` constant, which truncated all captured
  content at 60 KiB with no way to configure it.
- Truncation is now exact and character-safe: it fills the byte budget instead of discarding up to 64 characters per
  step, and it backs off UTF-8 continuation bytes so a multi-byte character is never split.
- Dependencies that the source imports but upstream only received transitively through `@opentelemetry/sdk-node`
  (`api-logs`, `sdk-logs`, `sdk-metrics`, and the `exporter-logs-*` / `exporter-metrics-*` packages) are now declared
  directly, so the tree installs and typechecks on its own.
- Upstream's docs-site, Biome, and release tooling were not adopted; only the extension source and its tests are
  vendored.

Behavior is otherwise byte-compatible with upstream `0.3.0`, and all 32 upstream tests pass unmodified.
