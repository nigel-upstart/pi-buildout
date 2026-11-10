# Routing layer — implementation decisions and simplifications

This log records simplifications made during implementation. Each must reduce moving parts without removing a functional
invariant from [`SPEC.md`](SPEC.md).

## S1 — TypeBox instead of Zod

**Decision:** import TypeBox's canonical `typebox` / `typebox/value` entry points (the same package bundled with pi) for
the semantic feature, planning, and classifier tool schemas.

**Why it is simpler:** one schema is accepted natively as a tool definition, has a static TypeScript type, and can be
validated by pi-ai's `validateToolArguments`. It removes extension-local dependency installation and schema conversion.

**Why it is not a nerf:** malformed output still fails closed by blocking automatic routing when no validated classifier
stage remains, enum/range/additional-property checks remain enforced, and the provider sees the exact same schema used
at runtime.

**Validation boundary (Pi 1.5):** TypeBox is an authoring, static-type, and local-validation choice, not the host's
tool-argument validator. Pi validates every model tool call against the tool's JSON Schema before an extension sees it:
from Pi 1.5.0, `validateToolArguments` compiles that schema with `@earendil-works/pi-schema` and returns a coerced
structured clone (numeric and boolean strings, a single value wrapped into a one-item array, a fractional integer
truncated, `null` in a string position as `"null"`); Pi 1.2.0-1.4.x applied TypeBox `Value.Convert` to TypeBox-authored
schemas with the same results and only primitive coercion to plain JSON Schema. Router tool schemas are
TypeBox-authored, so their accept/reject outcomes are unchanged across the supported range; only host error wording
differs. The router's local `typebox/value` checks then validate the normalized value strictly and never coerce, so
persisted, restored, and other untrusted data keep strict validation. Raw host validator errors include the received
arguments. Router classifier telemetry removes these free-form errors and keeps only error counts. This guarantee does
not cover ordinary Pi session transcripts: host-rejected planning or subagent calls produce error tool results that can
persist the raw validator error and received arguments alongside the original assistant tool call.
`extensions/router/pi-tool-arguments.test.mjs` pins these outcomes offline at the pinned Pi and in the floor/latest Pi
contract canary.

## S2 — Keep the user message native

**Decision:** compile model-specific system scaffolding but leave the request in pi's native user message instead of
embedding a duplicate copy in the system prompt.

**Why it is simpler:** no context rewrite or message deduplication is required.

**Why it is not a nerf:** the request is preserved byte-for-byte and remains in the strongest natural query position for
every provider. Compiler tests still verify that the request object is unchanged.

## S3 — Symbol-only OTel integration

**Decision:** consume `pi-telemetry-otel`'s global runtime/active-span registries when present; do not also statically
import its helper package.

**Why it is simpler:** no new runtime dependency, module-resolution branch, or duplicate tracing path.

**Why it is not a nerf:** the Symbol path provides the same tracer and active parent context. Absence of the optional
telemetry extension was already specified to no-op, while local JSONL remains the routing source of truth.

## S4 — One append-only telemetry representation

**Decision:** use JSONL events and derive percentile snapshots in memory; do not maintain SQLite or a second local
projection.

**Why it is simpler:** crash-safe append behavior, inspectable records, no migration/schema lifecycle, and one source of
truth.

**Why it is not a nerf:** route history is small, percentile computation is bounded, and promotion still requires
comparable mature samples and a quality floor.

## S5 — Exact policy candidates with deterministic resolution

**Decision:** policy stores ordered exact `(vendor, provider, model ID, effort, profile)` candidates, then resolves only
entries present in the live registry. It may use explicitly listed exact lower-tier fallbacks, never fuzzy “best model”
matching or silent aliases.

**Why it is simpler:** no benchmark ingestion service or mutable alias resolver in the first policy.

**Why it is not a nerf:** bootstrap ordering, availability, context, profile, vendor, and quality gates remain explicit
and explainable; telemetry can supersede order after maturity.

## S6 — Classifier transport seam, not a provider abstraction

**Decision:** production has one small adapter around pi-ai `complete()`; tests inject a function that returns
classifier arguments.

**Why it is simpler:** avoids a framework and provider-SDK wrappers.

**Why it is not a nerf:** real production/eval calls still use provider APIs, while deterministic unit tests can
exercise malformed output, reconciliation, and retries without credentials. The real-call eval suite itself never mocks
providers.

## S7 — One corpus file, many independently named fixtures

**Decision:** keep the small golden corpus as named rows in one `routes.json` rather than one JSON file per row.

**Why it is simpler:** one parse, one reviewable policy table, no fixture-discovery or cross-file schema drift.

**Why it is not a nerf:** every archetype still has an independently named prompt, feature override, and expected route,
and Node's test runner reports every row as a separate test.

## S8 — One repository lint tool and runtime-tested JavaScript fixtures

**Decision:** use ESLint as the only JavaScript/TypeScript linter and Prettier as the formatter; remove the leftover
Biome configuration. Keep all router production `.ts` files under strict TypeScript checking, while router `.test.mjs`
files are checked by ESLint and executed by Node's test runner rather than also being statically modeled by TypeScript.

**Why it is simpler:** there is one lint authority and no duplicate formatter. JavaScript test doubles can remain
minimal structural fakes instead of implementing dozens of unused pi API members solely to satisfy `checkJs`.

**Why it is not a nerf:** strict TypeScript still covers every shipped router source file, ESLint covers source and test
code, and every JavaScript fixture runs in the deterministic test suite. The repository's other JavaScript remains under
its existing `checkJs` policy.

## Rejected simplifications

- Keyword-only production classification: useful only as a fail-closed fallback because it cannot satisfy semantic
  ambiguity/confidence requirements.
- Reclassifying every turn: violates lease and cache invariants.
- One generic prompt for all vendors/generations: violates profile validation.
- Review by the builder only: loses required independence.
- Automatic active routing on first install: bypasses the required shadow evidence gate.
