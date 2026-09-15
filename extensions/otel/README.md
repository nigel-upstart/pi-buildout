# `extensions/otel`

A vendored, `pi-buildout`-owned fork of [`pi-otel`](https://github.com/NikiforovAll/pi-otel), imported at revision
`bf00f530d3667375a5317a0f425d0918e6cfac7e` (release `0.3.0`, Apache-2.0).

## Status

The fork is implemented, tested, and CI-gated, but **not activated by default**. `scripts/install-extensions.sh` ships
it only with `--with-otel`, and `upstart-dotfiles` still consumes the published `npm:pi-otel@0.3.0`. Only one
OpenTelemetry SDK can own a process, so the two must never be enabled together: whichever loads first owns the global
providers and the other silently stops exporting. The decision record, adoption sequence, and rollback are in
[`specs/otel-ownership-decision.md`](../../specs/otel-ownership-decision.md); the tracking issue is
[zew1me/pi-buildout#45](https://github.com/zew1me/pi-buildout/issues/45).

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
npm test          # builds, then runs the node:test suite
npm audit --omit=dev
```

CI runs the same commands in the `otel-extension` job of `.github/workflows/check.yml`, and fails the build on any high
or critical dependency finding.

## Dependencies

The tree runs the OpenTelemetry 2.x / 0.2xx train (`sdk-node@0.222`, `core` / `resources` / `sdk-trace-base` /
`sdk-metrics` at `2.11`, `semantic-conventions@1.43`). Upstream `0.3.0` pinned the 0.57.x / 1.30.x line, which reported
23 findings (19 moderate, 4 high) with no coherent override path: leaf overrides left `sdk-node` and `core` flagged,
overriding `sdk-node` failed with `EOVERRIDE` because it is a direct dependency, and a partial bump produced a mixed
1.x/2.x type tree. Migrating the whole train instead reports **0 findings**.

The migration needed three source changes, each marked in the affected file: `new Resource(...)` became
`resourceFromAttributes(...)`, the per-signal exporter helper now infers the three protocol classes independently
(they declare separate private members and are not mutually assignable), and `BatchLogRecordProcessor` takes an options
object.

## Semantic conventions

Three token-usage keys had drifted from the GenAI registry and now use the registry spelling:

| Emitted key | Pre-1.44 spelling, no longer emitted |
| --- | --- |
| `gen_ai.usage.cache_read.input_tokens` | `gen_ai.usage.cache_read_input_tokens` |
| `gen_ai.usage.cache_creation.input_tokens` | `gen_ai.usage.cache_creation_input_tokens` |
| `gen_ai.usage.reasoning.output_tokens` | `gen_ai.usage.reasoning_tokens` |

The old spellings are **not** written alongside the new ones. Nothing this repository owns queries them, and emitting
both would double the usage attribute count on every LLM span for no consumer. Anything that did query the old names
must be repointed at the registry keys above.

Two notes:

- `gen_ai.usage.cache_write.input_tokens` has no registry attribute as of 1.43.0 — the registry defines only
  `cache_read` and `cache_creation`. The name is ours, and follows the registry's shape for its siblings so the usage
  attributes are internally consistent. A test scans every registry export and fails if a real cache-write attribute
  ever appears, so it gets adopted rather than silently diverging.
- `gen_ai.system` is retained: it is still exported by `@opentelemetry/semantic-conventions@1.43.0`, so the concern that
  it had been removed does not hold. A test asserts this rather than trusting the reading.

The constants are asserted equal to the registry package's own exports, so a registry upgrade that renames a key fails a
test instead of drifting silently.

The constants are asserted equal to the registry package's own exports, so a registry upgrade that renames a key fails a
test instead of drifting silently.

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
- The OpenTelemetry dependency train moved to 2.x / 0.2xx, clearing all 23 inherited advisories.
- Cache and reasoning token keys use the current registry spelling, and the pre-1.44 spellings are dropped rather than
  dual-written.
- An export-contract test runs the real SDK against an in-process OTLP/HTTP receiver and asserts a 200 KB tool result
  arrives intact, which is the only check covering serialization rather than attribute assembly alone.
- Dependencies that the source imports but upstream only received transitively through `@opentelemetry/sdk-node`
  (`api-logs`, `sdk-logs`, `sdk-metrics`, and the `exporter-logs-*` / `exporter-metrics-*` packages) are now declared
  directly, so the tree installs and typechecks on its own.
- Upstream's docs-site, Biome, and release tooling were not adopted; only the extension source and its tests are
  vendored.

Behavior is otherwise compatible with upstream `0.3.0`: every upstream test passes unmodified, alongside the suites
added here. Exact counts are deliberately not quoted, since they go stale on every change; run `npm test` for the
current total.
