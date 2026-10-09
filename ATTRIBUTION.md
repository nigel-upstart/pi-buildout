# Attribution

## Subagent implementations

The subagent extension in [`extensions/subagents`](extensions/subagents) was informed by the two implementations
identified by the project owner. The implementation in this repository is original code, but it deliberately carries
forward architectural ideas and operational lessons from both projects.

## `nicobailon/pi-subagents`

- Repository: <https://github.com/nicobailon/pi-subagents>
- Initial revision reviewed: `315e1eb1482c4ac2d912a8d95aac4287dc7e60ac`
- Latest revision reviewed: `1b64c35cc221a23a5b8293deb108a30c0646f520` (`0.48.0` plus unreleased changes)
- License declared by its package: MIT

Ideas and lessons used:

- Treat a subagent as a separate Pi process and session rather than an in-process prompt persona.
- Keep asynchronous child work observable through structured state and transcript tails.
- Expose explicit lifecycle controls for status inspection, steering, interruption, and stopping.
- Bound child protocol and diagnostic output so a malformed or noisy child cannot grow parent memory without limit.
- Make recursive delegation safe by scoping child registries and controls to a parent/child tree rather than a global
  fleet.
- Validate model choices against Pi's live model registry and preserve a clear fallback path.
- Clean up child processes and extension-owned resources during Pi session shutdown/reload.
- Keep the child JSONL protocol bounded while allowing Pi-sized resized-image events; this repository uses a 16 MiB
  per-line ceiling.
- Sanitize child-controlled transcript and diagnostic text before terminal rendering while retaining the original
  bounded text in the model-facing tool result.

We intentionally did **not** reproduce its agent profiles, chain/parallel workflow engine, intercom/supervisor channel,
watchdog, artifact protocol, slash-command suite, or TUI fleet. This extension stays between that feature-rich design
and a one-shot runner.

## `elpapi42/pi-minimal-subagent`

- Repository: <https://github.com/elpapi42/pi-minimal-subagent>
- Local revision reviewed: `4c847a37b7d675470a8c5eb50d736d11ceac910a`
- License declared by its package: MIT

Ideas and lessons used:

- Keep the model-facing surface centered on one small `subagent` tool.
- Let ordinary natural-language requests cause the parent model to delegate; do not require a special slash workflow.
- Launch child Pi with normal extension/resource discovery by default so configured tools and integrations remain
  available.
- Resolve the Pi executable robustly when Pi is running either as a standalone executable or through Node.
- Use process isolation and propagate shutdown/abort behavior instead of sharing an agent session object.
- Keep task dispatch simple and avoid requiring named role/persona files.

We extended that minimal shape with persistent RPC children, task-targeted context compaction, automatic model/effort
classification, direct-child spying and control, and recursive child creation.

## `tintinweb/pi-subagents`

- Repository: <https://github.com/tintinweb/pi-subagents>
- Initial revision reviewed: `c161865a0e8ca12f406041c263ea6c2ca35c74d5` (`0.14.1`)
- Latest revision reviewed: `4cc473855c2af4f12873c01dad130dd0b3d52639` (`0.15.1`)
- License: MIT

This package was reviewed after the initial implementation as a source of possible follow-up ideas. The review
considered its in-process SDK sessions, background concurrency queue, graceful turn limits, result/steering tools,
conversation viewer, context-usage statistics, compact tool-description mode, model-scope guardrail, and resumable
sessions.

Follow-up work adopted three conceptual patterns: explicit, bounded result waiting; richer inspection statistics
(tokens, cost, context utilization, compactions, and active tool); and treating an output-limit stop with no assistant
text as a failed child run rather than a successful empty result. They were implemented as original code inside the
existing single-tool RPC design. No tintinweb code was copied or modified. Major pieces intentionally not adopted
include named/default agent types, custom agent frontmatter, proactive completion notifications, FleetView/widget UI,
scheduling, event-bus RPC, persistent memory, worktree isolation, skill preloading, and its three-tool Claude
Code-compatible surface.

## Routing layer (`extensions/router`)

Full design provenance, including the historical conversation export the router's spec derives from and the public
prompting/benchmark references consulted for background, is recorded in
[`specs/routing-layer/source-basis.md`](specs/routing-layer/source-basis.md) and
[`specs/routing-layer/decisions.md`](specs/routing-layer/decisions.md). The two external, runnable/integrable projects
referenced by the implementation are recorded here as well, per this file's role as the repository's attribution record
of first resort.

### Pi extension event semantics

- Sources: [`earendil-works/pi` issue #5581](https://github.com/earendil-works/pi/issues/5581); the `ToolExecutionMode`
  declaration in `@earendil-works/pi-agent-core` (`dist/types.d.ts`); and the "Events and concurrency" section of
  `@earendil-works/pi-coding-agent` `docs/extensions.md`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`, `packages/agent-core`)
- Revisions reviewed: published `1.0.3` for the issue behavior and `1.0.4` for tool-execution ordering; no Git commit
  was pinned
- License declared by the packages: MIT

Use, generated turns: idle `sendMessage({ triggerTurn: true })` turns skip `before_agent_start`. The router therefore
keeps its safety validator tools (`submit_action_plan`, `submit_discovery_request`, and `submit_safety_review`) declared
throughout active mode, and checks the actual mode, lease phase, and review fingerprint when a tool executes. Shadow and
off modes hide all three. We did not adopt the upstream proposed shared turn-preflight patch, fake user messages,
prose-only safety verdicts, or permanent tool exposure when routing is disabled.

Use, tool-execution ordering: in the default `parallel` mode, Pi runs the `tool_call` hooks for every call in one
assistant message sequentially, then executes the allowed calls concurrently. The router therefore spends a single-use
discovery grant in its `tool_call` handler, not at `tool_execution_end`.

No Pi code, issue prose, or documentation prose was copied or modified.

### `maximhq/bifrost`

- Repository: <https://github.com/maximhq/bifrost>
- Revision reviewed: not pinned; the router calls Bifrost only as a configured OpenAI-compatible HTTP gateway
  (`BIFROST_BASE_URL` / `BIFROST_VIRTUAL_KEY`) and vendors no Bifrost code
- License: not verified in this repository; see the upstream repository for its declared license

Use: Bifrost is the required real-provider transport for the opt-in explicit-provider evaluation harness
(`extensions/router/eval/real.test.mjs`, `npm run test:eval:real`) and an optional production gateway when a deployment
configures models through it. No Bifrost source was copied; the router only depends on its OpenAI-compatible request
contract and its Bedrock model-path naming, documented in
[`specs/routing-layer/decisions.md`](specs/routing-layer/decisions.md).

### `pi-telemetry-otel`

- Package: <https://www.npmjs.com/package/pi-telemetry-otel>
- Revision reviewed: not pinned; it is an optional, separately installed companion package, not an extension runtime
  dependency
- License: not verified in this repository; see the npm listing for its declared license

Use: `extensions/router/telemetry.ts` studies and consumes this package's public, documented integration contract — the
`Symbol.for("pi.telemetry-otel.runtimeRegistry.v1")` and `Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1")`
global registries — to emit optional parented OTel spans without a static dependency, and no-ops cleanly when the
package is absent. No `pi-telemetry-otel` source was copied.

### Amazon Bedrock pricing and prompt caching

- Sources: [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/),
  [Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), and
  [the January 2026 one-hour caching announcement](https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-bedrock-one-hour-duration-prompt-caching/)
- Revision reviewed: live documentation on 2026-08-11
- License: no documentation license was identified; no source code or documentation text was copied

Use: published per-token input and output list rates now drive cost-first endpoint ordering. Cache read/write semantics
establish the related cost classifications; the sources also establish default and one-hour TTL behavior, GPT-5.6's
explicit-breakpoint, minimum-prefix, and cache-usage-reporting behavior, and the exclusion of cache-read tokens from
input-token rate-limit quotas. The repository's operator-supplied `1.00001` Bedrock preference, which slightly
prioritizes first-party endpoints when list rates match, remains separate from and was not derived from AWS
documentation; the public pricing page supplies only its list-price basis. Provisioned-throughput and commitment pricing
were intentionally not adopted.

### Amazon Bedrock Converse tool choice and extended thinking

- Sources:
  [Bedrock Converse `ToolChoice`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolChoice.html)
  and
  [Claude extended thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html)
- Revision reviewed: live documentation and live Converse probes against Bedrock models on 2026-09-29
- License: no documentation license was identified; no source code or documentation text was copied

Use: `extensions/router/core/tool-choice.ts` forces the classifier's named tool via `toolConfig.toolChoice` and, because
Claude rejects budget-style extended thinking alongside a forced tool choice, drops the `thinking` budget form and the
interleaved-thinking beta from `additionalModelRequestFields`. Adaptive thinking and other request fields and betas are
preserved. Providers other than Bedrock Converse, and models that ignore a named tool choice, were intentionally not
adopted.

### Provider model catalogs (Amazon Bedrock and GitHub Copilot)

- Sources: the Amazon Bedrock
  [`ListFoundationModels`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html) and
  [`ListInferenceProfiles`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html) APIs
  (us-east-1, us-east-2, us-west-2) and the GitHub Copilot `/models` endpoint, whose catalog is documented in
  [Supported AI models in GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models), plus
  live classifier-shaped probes (forced tool call at low reasoning effort) against the listed endpoints
- Revision reviewed: live catalog responses and probes on 2026-09-29
- License: catalog data only; no source code or documentation text was copied

Use: `canonicalVendor` in `extensions/router/core/routing.ts` recognizes the model-ID spellings those catalogs publish
for xAI (`grok-`, `xai.grok-`), Z.ai (`glm-`, `zai.glm-`), Qwen (`qwen`, `qwen.qwen`), NVIDIA (`nemotron-`,
`nvidia.nemotron-`), and Microsoft (`mai-`), and strips Bedrock region prefixes before those vendor segments. The
classifier tiers in `extensions/router/pi-classifier.ts` add `mai-code-1.1-flash`, the only Microsoft model the Copilot
catalog served that returned the forced tool call. Models that failed the probe (Meta Llama tool use, Gemma named-tool
choice, `mai-code-1-flash-picker`, DeepSeek R1) were intentionally not adopted, and no prompt profile or route was
derived from the probes.

### Anthropic prompt caching

- Source: [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Revision reviewed: live documentation on 2026-08-11
- License: no documentation license was identified; no source code or documentation text was copied

Use: Claude's 5-minute cache-write and cache-read multipliers, TTL refresh behavior, 1-hour write multiplier, and the
models/providers for which the 1-hour option is documented. Only behavioral and pricing facts were consulted; no SDK,
example code, or prose was copied.

### OpenAI prompt caching

- Source: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- Revision reviewed: live documentation on 2026-08-11
- License: no documentation license was identified; no source code or documentation text was copied

Use: GPT-5.6 implicit and explicit breakpoints, its 30-minute minimum TTL, automatic caching for earlier models,
in-memory inactivity/maximum retention, extended retention, and minimum-prefix behavior. The comparison preserves the
documented GPT-5.6 TTL parity with Bedrock and treats any provider hit-rate difference as unmeasured; none of these
facts is used as a token-price claim. No SDK or example code was copied.

## LLM effectiveness research corpus and its upstream benchmark sources

The router's bootstrap priors in [`extensions/router/core/evidence.ts`](extensions/router/core/evidence.ts) and
[`specs/routing-layer/model-evidence-2026-07-25.json`](specs/routing-layer/model-evidence-2026-07-25.json) are derived
from a local research corpus and the public benchmark captures it aggregates.

- Source: local `llm-effectiveness` research corpus (`~/outputs/llm-effectiveness`), normalization version `2.0`
- Initial revision reviewed: capture dated 2026-07-25, spend data through 2026-07-19
- Latest revision reviewed:
  [`teamupstart/ai-acceleration` PR #650](https://github.com/teamupstart/ai-acceleration/pull/650) at
  `a99c2d0145952f99ad92f6d786ef0aa19fa15c97`, report data through 2026-09-22; latest remote `main` reviewed at
  [`392b967c5ec3ea8d63078ddbc31a8b16a1f22836`](https://github.com/teamupstart/ai-acceleration/commit/392b967c5ec3ea8d63078ddbc31a8b16a1f22836)
- License: internal working data; not redistributed by this repository

Use: numeric priors (deterministic pass rate, hard-task pass rate, regression-breakage rate, partial credit on failure,
repeat reliability, wall time, agent steps, p90 peak context, cost per pass) were derived from the initial corpus's
`analysis/router_capability_slices.py` output and its `ROUTING_LEARNINGS.md` interpretation, then transcribed as typed
data with per-row provenance. The refreshed report contributes GPT-6 Astra's direct DeepSWE pass, hard-task,
repeatability, latency, steps, cost (as corrected by DataCurve's 2026-09-22 recapture), and language-slice observations
plus its two-source max-tier corroboration; Gemini 3.8 Flash's effort-specific consensus band, CursorBench score, and
DeepSWE observations; and current Artificial Analysis intelligence and speed context. GPT-6 Luna/Sol deliberately
inherit the corresponding GPT-5.6 Luna/Sol priors, and Claude Opus 5.5 inherits Opus 5, as operator-requested generation
proxies. Their cost per pass is repriced from the report's verified vendor list rates
(`artificialanalysis.ai/pricing-source-data.csv`) applied to each source row's measured DeepSWE token totals
(`datacurve_deepswe_v1.1/derived/rollout_metrics_by_config.csv`); only those numbers and Astra's direct row were
transcribed, into
[`specs/routing-layer/generation-evidence-2026-09-22.json`](specs/routing-layer/generation-evidence-2026-09-22.json).
The single-source CursorBench 4.0 and Artificial Analysis observations for GPT-6 Sol/Luna and Opus 5.5 were
intentionally not adopted as priors, because they supply no regression, repeatability, or latency-tail fields. Astra
high retains Sol-high regression, failed-trial partial-credit, and p90-peak-context fields only where the Astra source
has no observation, and is confined to high-intelligence planning/advisory/review ladders. No corpus or `ai_usage` code,
prose, or raw benchmark records were copied. The report's Sonnet experiment proposal, frontend task heuristics, and
automatic cross-model percentile ranking were intentionally not adopted; the router preserves its existing consequence
gates and requires local acceptance telemetry before automatic promotion.

Upstream sources that corpus aggregates, all consumed as published measurements rather than code:

- **DataCurve DeepSWE v1.1** — <https://deepswe.datacurve.ai/data/v1.1>; artifacts `trials.json` and `tasks.json`,
  22,586 rollouts over 113 tasks on the `mini-swe-agent` harness. License not declared on the data page. Used for pass
  rate, regression breakage, reliability, wall time, steps, peak context, and cost-per-pass priors, including the
  language buckets.
- **CursorBench 3.2** — <https://cursor.com/cursorbench>; captured 2026-07-24. License not declared. Used only as
  independent corroboration of candidate ordering. Cursor's Grok 4.5 training-contamination disclosure is preserved.
- **Artificial Analysis** — <https://artificialanalysis.ai>; captured 2026-07-24 from a logged-in non-Pro session.
  License not declared; task cost/time are absent from that capture. Used for capability and list-price context only.
- **CloudZero observed spend** — <https://app.cloudzero.com>; 30-day AWS Marketplace Claude window ending 2026-07-24.
  Internal billing observations. Used only to distinguish observed route rates from published list prices.

Two sources were added to that corpus on 2026-07-25 and inform the per-language routing policy without contributing
numeric priors:

- **SWE-bench Multilingual leaderboard** — <https://www.swebench.com/multilingual-leaderboard.html>; captured
  2026-07-25; 300 tasks across 8 language labels, single-attempt `mini-swe-agent`. License not declared on the
  leaderboard page; the SWE-bench project is MIT-licensed and the dataset is published as
  `SWE-bench/SWE-bench_Multilingual`. Used only for language difficulty ordering, which is what survives the corpus's
  generation-currency rule. Its per-vendor per-language comparisons were **deliberately not adopted**: all three OpenAI
  submissions are GPT-5.2-era and excluded, so those comparisons were cross-generation rather than cross-vendor.
- **OskarsEzerins `llm-benchmarks`** — <https://github.com/OskarsEzerins/llm-benchmarks>; revision `c5ad31674aeb`;
  captured 2026-07-25; declared license MIT (© Oskars Ezerins). The only retained source that evaluates
  current-generation router candidates on Ruby. Used as a weak near-tie preference and as the basis for requiring a
  RuboCop gate on Ruby routes. Its four-task Minitest pass ratios were **deliberately not adopted** as pass-rate priors,
  because they measure a different construct than the rollout verifier outcomes and have very low statistical power. No
  upstream code was copied.

Intentionally not adopted: no raw benchmark score is copied into runtime policy, no arithmetic is performed across
incompatible benchmarks, no Artificial Analysis GitHub Copilot price is treated as a real cost, and no
unsupported-vendor model (Kimi, Grok, GLM, Muse) is made a routing candidate. Benchmark pass rates are treated strictly
as pre-telemetry ordering priors and never as the router's acceptance signal.

### Scoped-model analysis refresh

- Source: local `llm-effectiveness` research corpus (`/Users/nigel.stuke/outputs/llm-effectiveness`), with data through
  2026-08-13
- Registry source: `@earendil-works/pi-ai@0.80.7` generated model registry
- Upstream measurement and pricing sources: [DataCurve DeepSWE v1.1](https://deepswe.datacurve.ai/data/v1.1),
  [SWE-bench Verified and SWE-bench Multilingual](https://www.swebench.com/), [CursorBench](https://cursor.com/evals),
  [Artificial Analysis](https://artificialanalysis.ai/),
  [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/), and CloudZero authenticated AWS cost data
- Revision reviewed: corpus capture with source data through 2026-08-13 and the pinned pi-ai registry above; no
  independent public-page revisions were pinned
- Licenses: pi-ai and the SWE-bench project declare MIT; the local corpus and CloudZero observations are internal; no
  license was identified for the DataCurve data, CursorBench, Artificial Analysis, or AWS documentation

Use: endpoint-rate observations, the CloudZero token mix, benchmark outcomes, and derived break-even and
cost-per-resolved comparisons were transcribed as numeric data into
[`specs/routing-layer/scoped-model-analysis-2026-08-13.md`](specs/routing-layer/scoped-model-analysis-2026-08-13.md).
The completion-cost, cache-sensitivity, generation-currency, and reachable-versus-measured interpretations were used as
conceptual analysis. No upstream prose or code was copied or modified.

Intentionally not adopted: the analysis makes no runtime policy change, transfers no evidence between unmatched model
versions, does not treat single-attempt verifier outcomes as human acceptance, and does not infer unverified Bedrock
cache or tool-call behavior.

### Single-attempt evidence class

- Sources: the same [SWE-bench Verified and SWE-bench Multilingual](https://www.swebench.com/) leaderboard captures
  recorded above, taken from the local `llm-effectiveness` corpus capture with source data through 2026-08-13
- Revision reviewed: that corpus capture; no independent public-page revision was pinned
- License: the SWE-bench project declares MIT; the local derivation is internal

Use: single-attempt resolve rates, each submission's own reported cost per attempted task, median API-call counts, and
per-language resolve and cost-per-resolved slices for ten submissions were derived into
[`specs/routing-layer/single-attempt-evidence-2026-08-13.json`](specs/routing-layer/single-attempt-evidence-2026-08-13.json)
by [`scripts/generate-single-attempt-evidence.mjs`](scripts/generate-single-attempt-evidence.mjs) and mirrored into
[`extensions/router/core/single-attempt-data.ts`](extensions/router/core/single-attempt-data.ts). This is the first
runtime use of these numbers; the earlier entry above described a documentation-only record. No upstream prose or code
was copied or modified.

Intentionally not adopted: the leaderboard's own ranking and any percentile derived from it are not used as an ability
scale, because the cost-bearing Verified population tops out at a prior-generation frontier model. The five terms the
router's cost-to-done model requires and single-attempt submissions cannot measure were not estimated or defaulted, and
the data is structurally barred from that model rather than down-weighted within it. No model became routable.

## Pi 0.85.1 `/skills` runtime patch (retired)

Historical attribution retained for the shared overlay. Its versioned artifacts were removed in #109.

- Source: `@earendil-works/pi-coding-agent@0.85.1`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`)
- License declared by the package: MIT

`patches/pi-0.85.1/skills.patch` is a modified-code patch against Pi's published, generated runtime and documentation.
It modifies upstream `dist/bundle/cli.js`, `dist/bundle/rpc-entry.js`, `dist/core/resource-loader.js`,
`dist/core/slash-commands.js`, `dist/main.js`, `dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their
unchanged context and modified lines derive from the MIT-licensed Pi package. The bundled entrypoints become thin
wrappers so the patched unbundled runtime handles CLI and RPC execution. The added `dist/core/skill-management.js` is
primarily an original implementation for this repository, informed by Pi's resource-loading and command conventions.

The persisted-skill locking helpers are modified adaptations of the synchronous `proper-lockfile` retry and guaranteed
release pattern in Pi's MIT-licensed `dist/core/trust-manager.js`; the integration around the complete skill
read-modify-write transaction is original to this repository. The patch adopts explicit global, repository, and session
skill activation; a discoverable-but-inactive catalog; normalized repository identity; shared CLI and interactive
command semantics; diagnostics for invalid configuration; concurrent-update locking; and checksum-guarded installation.
Its catalog reuses Pi's package manager to include enabled package and settings skill sources while preserving Pi's
precedence and project-trust behavior. It intentionally does not adopt automatic loading of every discovered skill,
configured-path confinement, new public resource-loader mutator APIs, or changes to Pi's unrelated extension, prompt,
theme, package, trust, and provider behavior.

## Pi 0.87.1 `/skills` runtime patch (retired)

Historical attribution retained for the shared overlay. Its versioned artifacts were removed in #109.

- Source: `@earendil-works/pi-coding-agent@0.87.1`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` (`v0.87.1`)
- License declared by the package: MIT

`patches/pi-0.87.1/skills.patch` is a modified-code patch against Pi's published, generated runtime and documentation,
generated from the TypeScript overlay below. It modifies upstream `dist/bundle/cli-runtime.js`,
`dist/bundle/rpc-entry.js`, `dist/core/resource-loader.js`, `dist/core/slash-commands.js`, `dist/main.js`,
`dist/modes/interactive/interactive-mode.js`, and `docs/skills.md`; their unchanged context and modified lines derive
from the MIT-licensed Pi package. The bundled runtime and RPC entrypoints become thin wrappers so the patched unbundled
runtime handles CLI and RPC execution; upstream's `dist/bundle/cli.js` compile-cache loader is left unchanged and is
only pinned by checksum in both manifests. The added `dist/core/skill-management.js` and
`dist/core/skill-management-core.js` are compiled from this repository's original overlay code and are byte-identical to
the 0.85.1 patch's copies.

The patch adopts the same behavior as the 0.85.1 patch: explicit global, repository, and session skill activation; a
discoverable-but-inactive catalog built on Pi's package manager; normalized repository identity with non-default ports
preserved; shared CLI and interactive command semantics; strict configuration validation; concurrent-update locking of
persisted skill configuration; and checksum-guarded installation. The locking helpers adapt the same `proper-lockfile`
pattern from Pi 0.87.1's MIT-licensed `dist/core/trust-manager.js`, which is unchanged in shape from 0.85.1. It
intentionally does not adopt Pi 0.87.1's automatic loading of every discovered skill, and does not change Pi's unrelated
extension, prompt, theme, package, trust, provider, compile-cache, or bundled-chunk behavior. The `docs/skills.md`
changes were rewritten against 0.87.1's restructured skills page rather than carried over from 0.85.1.

The retired 0.87.1 entrypoint test wrote a five-line stand-in for upstream 0.87.1's `dist/bundle/cli.js`
(`enableCompileCache()` followed by `createRequire(import.meta.url)("./cli-runtime.js")`). That shape is adapted from
the MIT-licensed Pi package so the test can exercise the same `require()` dispatch the published loader performs.

## Pi 1.0.3 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.0.3`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `d78dc83d633229d12f8b79631384c4c2717c399f` (`v1.0.3`), from npm `gitHead`
- Source archive: `pi-1.0.3-source.tar.gz`, verified against the release's published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay/versions/1.0.3/integration.patch`](pi-overlay/versions/1.0.3/integration.patch) adapts the existing opt-in
skills seam to the MIT-licensed 1.0.3 TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.0.3/skills.patch) modifies the published resource loader, slash-command list, CLI and
interactive entry points, and `docs/skills.md`; it adds this repository's original skill-management modules. The patch
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs, including the adapted lock pattern
previously attributed above. It keeps discovered skills catalog-only, enables explicit global, repository, and session
activation, preserves explicit `--skill` paths with `--no-skills`, and leaves Pi's unrelated extensions, prompts,
themes, packages, providers, trust behavior, and bundled chunks unchanged. It does not copy Pi's automatic skill-loading
behavior or its runtime implementation into the overlay.

The `cli-runtime.js` and `rpc-entry.js` replacements are original wrappers reused from the earlier generated patch; Pi's
published `dist/bundle/cli.js` compile-cache loader remains unchanged and is pinned by checksum. Source inputs are
fetched from the 1.0.3 release archive and npm tarball with committed checksums; no complete Pi source checkout is
committed.

## Pi 1.0.4 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.0.4`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `7c10bd4337495ee613f2224843ecdf349b80d1df` (`v1.0.4`), from npm `gitHead`
- Source archive: `pi-1.0.4-source.tar.gz`, verified against the release's published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay/versions/1.0.4/integration.patch`](pi-overlay/versions/1.0.4/integration.patch) adapts the opt-in skills
integration seam to the MIT-licensed 1.0.4 TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.0.4/skills.patch) modifies Pi's published resource loader, slash-command list, CLI and
interactive entry points, and skill documentation. It adds this repository's original skill-management modules and
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs. It preserves explicit `--skill` with
`--no-skills`, makes discovered skills catalog-only until activated, and leaves unrelated extensions, prompts, themes,
packages, providers, trust behavior, and bundled chunks unchanged. Pi's automatic loading of all discovered skills and
its skill implementation were not copied into the overlay. The original `cli-runtime.js` and `rpc-entry.js` wrappers are
reused from the earlier patch; the published `dist/bundle/cli.js` loader is unchanged and checksum-pinned. Inputs come
from the verified release archive and npm tarball; no complete Pi source checkout is committed.

## Pi 1.1.0 `/skills` runtime patch

- Source: `@earendil-works/pi-coding-agent@1.1.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revision reviewed: `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`)
- Source archive: `pi-1.1.0-source.tar.gz`, verified against the release's published `SHA256SUMS`
- License declared by the package: MIT

[`pi-overlay/versions/1.1.0/integration.patch`](pi-overlay/versions/1.1.0/integration.patch) adapts the opt-in skills
seam to Pi 1.1.0's MIT-licensed TypeScript sources and documentation. The generated
[`skills.patch`](patches/pi-1.1.0/skills.patch) modifies the published resource loader, slash-command list, CLI and
interactive entry points, and skill documentation. It adds this repository's original skill-management modules and
reuses Pi's package/resource discovery, project-trust, and `proper-lockfile` APIs. It keeps catalog skills inactive
until explicitly enabled, preserves explicit `--skill` paths with `--no-skills`, and does not copy Pi's automatic skill
loading or its skill implementation. The original `cli-runtime.js` wrapper reuses Pi's `setupCli()` path; the original
`rpc-entry.js` wrapper also preserves Pi 1.1.0's process markers and HTTP-dispatcher setup. The published
`dist/bundle/cli.js` loader remains unchanged and checksum-pinned. No complete Pi source checkout is committed.

## Pi `/skills` TypeScript overlay

- Source: `@earendil-works/pi-coding-agent@0.85.1`, `@earendil-works/pi-coding-agent@0.87.1`,
  `@earendil-works/pi-coding-agent@1.0.3`, `@earendil-works/pi-coding-agent@1.0.4`, and
  `@earendil-works/pi-coding-agent@1.1.0`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Upstream revisions reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477` (`v0.85.1`),
  `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` (`v0.87.1`), `d78dc83d633229d12f8b79631384c4c2717c399f` (`v1.0.3`),
  `7c10bd4337495ee613f2224843ecdf349b80d1df` (`v1.0.4`), and `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`),
  taken from the corresponding signed release tag
- Source acquired from the release assets `pi-0.85.1-source.tar.gz`, `pi-0.87.1-source.tar.gz`,
  `pi-1.0.3-source.tar.gz`, `pi-1.0.4-source.tar.gz`, and `pi-1.1.0-source.tar.gz`, each verified against upstream's
  published `SHA256SUMS` for that release
- License declared by the package: MIT

[`pi-overlay`](pi-overlay) is the authored form of the `/skills` runtime patch; the artifacts under
`patches/pi-0.85.1/`, `patches/pi-0.87.1/`, `patches/pi-1.0.3/`, `patches/pi-1.0.4/`, and `patches/pi-1.1.0/` are
generated from it.

`pi-overlay/skill-management-core.ts` and `pi-overlay/skill-management.ts` are original code for this repository. They
are a TypeScript reimplementation of the `dist/core/skill-management.js` previously authored here as JavaScript,
informed by Pi's resource-loading and command conventions rather than copied from an upstream file. They additionally
absorb logic that earlier versions of the patch inlined into upstream files, so those files now receive only imports and
call sites.

The persisted-skill lock in `pi-overlay/skill-management-core.ts` (`acquireSkillConfigLock` and `withSkillConfigLock`)
is a modified adaptation of the `acquireTrustLockSync` and `withTrustFileLock` pattern in Pi's MIT-licensed
`src/core/trust-manager.ts`: a synchronous `proper-lockfile` lock on a sibling `.lock` path, retried only on `ELOCKED`,
and released in `finally`. It differs by waiting with `Atomics.wait` instead of busy-spinning, allowing more attempts,
and reporting rather than throwing a failed release so the update's own result or error is preserved. The shell binds
Pi's existing `proper-lockfile` dependency, which both 0.85.1 and 0.87.1 ship; no new upstream dependency is introduced.

`pi-overlay/versions/0.85.1/integration.patch` and `pi-overlay/versions/0.87.1/integration.patch` are modified-code
patches against Pi's MIT-licensed TypeScript sources for those releases: `src/core/resource-loader.ts`,
`src/core/slash-commands.ts`, `src/main.ts`, `src/modes/interactive/interactive-mode.ts`, and `docs/skills.md`. Their
unchanged context and modified lines derive from the MIT-licensed Pi package. The 0.87.1 seam was rebased by re-reading
the 0.87.1 sources: the code call sites are unchanged, its interactive-mode import extends the existing `utils/paths.ts`
import, and its documentation hunk targets the rewritten skills page.

`pi-overlay/versions/0.85.1/replacements/dist/bundle/cli.js` and `rpc-entry.js`, and
`pi-overlay/versions/0.87.1/replacements/dist/bundle/cli-runtime.js` and `rpc-entry.js`, are original hand-written
wrappers, not derived from upstream's generated bundle output. They replace Pi's esbuild-produced bundled entrypoints so
the patched unbundled runtime handles CLI and RPC execution. The 0.87.1 wrappers have the same content as the 0.85.1
ones, because 0.87.1's `src/cli.ts`, `src/cli/setup.ts`, and `src/rpc-entry.ts` are unchanged from 0.85.1.

This repository vendors no upstream source and maintains no fork. Upstream source is fetched per generation run against
pinned, checksum-verified inputs, and is not committed here.

## Pi documentation and examples

- Source: `@earendil-works/pi-coding-agent`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Releases reviewed: `0.80.6`, `0.80.7`, `0.82.0`, `0.82.1`, `0.83.0`, `0.84.0`, `0.84.1`, `0.84.2`, `0.84.4`, and
  `0.85.1`
- Latest documentation and example revision reviewed: `d981de1229ef899957bbe968bc8dcda02a21f477`
- License declared by the package: MIT

Ideas and API patterns used:

- Extension tool registration, lifecycle shutdown hooks, resource discovery, and TUI tool rendering.
- Runtime active-tool selection through `getActiveTools()` / `setActiveTools()`, used to keep all three safety
  validators declared throughout active routing; each validator enforces its mode and lease phase at execution time.
- The Pi 0.85.1 and 0.87.1 versioned skills catalogs reuse `DefaultPackageManager.resolve()` and its resolved-resource
  metadata to discover package and settings skills with upstream manifest, filtering, scope, and precedence behavior.
  The catalog merge and opt-in activation logic remain original code; Pi's automatic skill loading is intentionally not
  adopted.
- The Pi 0.85.1 and 0.87.1 patches adapt the synchronous `proper-lockfile` acquisition/retry and `finally` release
  pattern from Pi's trust manager so skill configuration updates serialize across processes.
- SDK `AgentSession.compact()` with custom instructions and in-memory sessions.
- RPC JSONL framing and the `prompt`, `steer`, `follow_up`, `abort`, state, and event protocols.
- Pi `1.1.0`'s published package layout (the `.` export resolving under `dist/`, with the `pi` bin at
  `dist/bundle/cli.js`), its `--mode rpc` CLI flags, and the `registerProvider()` API documented in
  `dist/core/extensions/types.d.ts`. `extensions/subagents/rpc.integration.test.mjs` uses these to launch the pinned Pi
  CLI in RPC mode, and `rpc.integration-provider.mjs` registers a test-only `openai-completions` provider that points at
  a local deterministic fixture. The test asserts Pi's observable `prompt`, `follow_up` (queued while streaming),
  `get_state`, `get_session_stats`, and shutdown behavior. No Pi code was copied.
- Model-registry authentication, fuzzy CLI-equivalent model resolution, thinking-level capability maps, and normal child
  resource inheritance.
- The `@earendil-works/pi-ai@0.80.7` generated registry's endpoint rates and capabilities, plus its `calculateCost`
  cache-accounting behavior, as versioned evidence for the offline endpoint survey and routing evidence document. No
  registry generator or cost-calculation code was copied or adopted into the router runtime.
- Pi's thinking-level clamp policy (prefer the nearest supported level above the request, fall back downward only when
  necessary) is a conceptual adaptation, reimplemented in `extensions/subagents/helpers.ts`; no Pi code was copied.
  `supportedThinkingLevels` additionally narrows OpenAI's direct GPT-5.6 levels beyond what Pi's generated model
  metadata declares, because the live endpoint rejects `minimal` and `max`. Pi's own permissive handling of those two
  levels is intentionally not adopted.
- Pi's bundled subagent and custom-compaction examples as reference implementations for process invocation, output
  bounds, and compaction setup.

Major pieces intentionally not adopted include Pi's full interactive mode, session-replacement runtime, prompt-template
workflows, custom provider implementations (beyond the test-only integration fixture above), and bundled role-based
subagent profiles. No Pi source file or example was copied verbatim; the extension is original code using Pi's published
APIs and adapting the documented architectural patterns.

### Router start-mode scoping (`extensions/router/core/start-mode.ts`)

The router's start-mode configuration reuses the repository-identity scoping mechanism introduced by this repository's
version-pinned pi skills patch (`patches/pi-0.83.0/skills.patch`, applied to `@earendil-works/pi-coding-agent@0.83.0`,
MIT), which itself extends pi's skills configuration.

- Adopted as **modified code**: the git-remote normalization and repository-key resolution algorithm — remote preference
  order `upstream`, `origin`, then the first configured remote; normalization of SCP-style, HTTPS, `git+`, and `ssh://`
  URLs to `host:path`; and the `local:~/<path-relative-to-$HOME>` fallback for a repository with no usable remote. The
  router's copy is retyped for TypeScript, split into a pure module with the git calls kept in the extension's I/O
  layer, and hardened against prototype-polluting keys. Keeping the algorithm identical is deliberate so
  `repo-skills.json` and `repo-router-config.json` use one key format.
- Adopted as **conceptual pattern**: a global JSON configuration file plus a repository-keyed file in the agent
  directory, where the repository entry overrides the global value.
- **Intentionally not adopted**: the skills catalog/activation model, session-scoped (`--session`) entries, the
  `/skills` command surface, and the enabled-entry list shape. Router start mode is a single scalar preference per
  scope, not a list, and it is not settable from a slash command.

## `shell-quote` and `shlex` (router shell tokenizer dependencies)

- Sources: `shell-quote` (<https://github.com/ljharb/shell-quote>, version `1.11.0`, MIT) and `shlex`
  (<https://github.com/rgov/node-shlex>, version `3.0.0`, MIT).
- Both are consumed as ordinary npm dependencies by `extensions/router/core/shell.ts`. No code from either package was
  copied or modified, and both ship their own type declarations. `shell-quote` was raised to the first patched release
  for [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv); this does not change the adopted API.

What each is used for, and why both:

- `shell-quote`'s `parse` supplies the token structure the read-only gate needs, classifying control operators, glob
  patterns, and comments as distinct entries rather than as text.
- `shlex`'s `split` supplies malformed-quoting detection, which `shell-quote` does not report: it accepts an unbalanced
  quote silently.

Behavior of both libraries that this repository deliberately compensates for, rather than relying on:

- Both treat newlines and carriage returns as ordinary whitespace, so a two-line command lexes into one argument list.
  Control characters are therefore rejected on the raw string before either lexer runs.
- `shell-quote` performs parameter expansion during parsing and yields an empty token for an unset variable, so `$` and
  backticks are rejected before parsing rather than interpreted.

The argv policy itself — the allowed binaries, git subcommands, and per-binary flag allowlists — is original code in
this repository and is not derived from either package.

## `pi-web-access` (removed local OpenAI auth patch)

- Source: `pi-web-access`
- Canonical repository: <https://github.com/nicobailon/pi-web-access>
- Revision reviewed: published npm package `0.14.0`
- License declared by the package: MIT (© 2025 Nico Bailon)

No derived material from this package remains in the repository. A one-hunk modification to that release's
`openai-search.ts` was tracked briefly and then deleted once the installed package moved to `0.22.0`, where the patched
construct no longer exists and the hunk no longer applies. It was never vendored: no upstream source file was copied
here, and the package retains its own `LICENSE`.

The entry is kept because the modification did exist and was applied to an installed package tree.
`patches/pi-web-access-0.14.0/REMOVED.md` records what the patch changed, what it deliberately left in place, why it was
removed, and the commit plus baseline and patched SHA-256 values needed to recover or verify it. Do not reapply that
diff to another version; derive a fresh one from the clean package of the version actually installed.

## `pi-otel` (vendored OpenTelemetry extension fork)

- Source: `pi-otel`
- Canonical repository: <https://github.com/NikiforovAll/pi-otel>
- Revision vendored: `bf00f530d3667375a5317a0f425d0918e6cfac7e` (release `0.3.0`)
- License declared by the source: Apache-2.0 (© 2026 Oleksii Nikiforov)

`extensions/otel` is a vendored fork, not conceptual inspiration: the extension source under `extensions/otel/src` and
its test suite under `extensions/otel/test` are copied from that revision. The upstream `LICENSE` is retained verbatim
at `extensions/otel/LICENSE`, and every file modified after the import carries a prominent notice naming the change, as
Apache-2.0 §4(b) requires.

What was adopted: the pi lifecycle wiring, the GenAI span tree (`invoke_agent` / `chat` / `execute_tool`), provider-name
normalization, content-capture modes, token and cost attributes, the OTLP SDK bootstrap across the traces, metrics, and
logs signals, shell trace propagation, and the `/otel` dashboard command.

What was intentionally not adopted: the upstream VitePress documentation site, the Biome configuration, the Husky hooks,
and the npm publication workflow. The upstream directory layout (`src/`, `test/`) is preserved so later upstream
revisions remain diffable, which is also why the root project's formatter, linter, and typechecker exclude this
directory rather than restyling the vendored source.

Owned modifications at import: the package manifest declares the OpenTelemetry packages the source imports but upstream
only obtained transitively through `@opentelemetry/sdk-node`, so the vendored tree installs and typechecks standalone.
Subsequent owned changes are recorded in `extensions/otel/README.md` and in the per-file notices: a configurable
`otel.maxAttributeBytes` cap replacing upstream's module-private 60 KiB `MAX_ATTR_BYTES` constant (keeping 60 KiB as the
default and making truncation exact and character-safe), migration of the whole OpenTelemetry dependency train to the
2.x / 0.2xx line with the three API changes it required, GenAI registry spellings for the cache and reasoning token keys
replacing the pre-1.44 spellings rather than dual-writing them, and corrections to the `/otel` command so status probes
the configured endpoint's own host (rejecting non-HTTP schemes and unbracketing IPv6 literals) and start announces only
a dashboard that actually came up. It also resets the session-start bookkeeping across session transitions and marks a
failed LLM request's span, both of which upstream omits.

### Provider-scoped OpenTelemetry ownership

- Source: `pi-otel-telemetry`
- Canonical repository: <https://github.com/mprokopov/pi-otel-telemetry>
- Revision reviewed: `d9714929da0cff692dc7b7dece8d643a231aed51`
- License declared by the source: MIT

Conceptual use: that revision demonstrates the provider-scoped tracer pattern — obtain a tracer directly from an owned
provider instead of registering it globally — and documents why global one-time registration loses spans after reload.
The same ownership principle informed `extensions/otel/src/otel/sdk.ts`, generalized independently across trace, metric,
and log providers so the owned Pi extension can coexist with a foreign SDK.

No source code was copied or modified from `pi-otel-telemetry`. Its implementation's signal scope, data model, and
reload mechanics were not adopted. This repository retains its existing Pi GenAI span tree, constructs its own scoped
providers/exporters, explicitly preserves shell trace context, separates metric resources for cardinality control, and
records exporter delivery health.

## Internal npm release packaging

- Source: `teamupstart/umt`, <https://github.com/teamupstart/umt>, `internal/artifacts/roles.go` and
  `internal/artifacts/dotfile/npm.go` at revision `139ea84b36fd550fb29ba91649975d39e3734817`; license not established
  from the reviewed files.
- Source: Upstart CodeArtifact guide, <https://upstartnetwork.atlassian.net/wiki/spaces/DEL/pages/6780387430>.
- Source: Pi package documentation,
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>, MIT.

Conceptual use only: the manual release instructions use UMT's production CodeArtifact domain/repository, publish SSO
role, and full-path npm token scoping. The Pi manifest and peer-dependency design follow Pi's package documentation. No
UMT or Pi code was copied into the release scripts; UMT's automatic dotfile/profile changes and CI publishing action
were intentionally not adopted. The router/OTel runtime companions share a package, while independent extensions and the
standalone patch are separate packages. The OTel source is redistributed with its Apache-2.0 license intact.

## `zew1me/pi-buildout` (upstream of this fork)

- Source: `zew1me/pi-buildout`
- Canonical repository: <https://github.com/zew1me/pi-buildout>
- Revision last synced: `867d931ee84de52e46e1b456d95338c236a804d5` (2026-09-28)
- License declared by the source: MIT (© 2026 Nigel Stuke)

This repository is a fork of `zew1me/pi-buildout`. Upstream changes are ported by cherry-picking commits rather than by
merging, so each ported commit records its upstream SHA in a `(cherry picked from commit …)` trailer, and
[`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md) records the last synced revision and the status of each upstream commit.

What was adopted, as copied code: the pi 0.84.4 and 0.85.1 `/skills` patch sets under `patches/` (the 0.84.4 set, like
0.84.2's, was later removed at `867d931e`), including the recognized-state upgrade manifests for installs patched by
this repository's earlier 0.85.1 patch; the package and settings skill catalog for the pi 0.84.2 patch; the
manifest-driven patch file set, recognized-state upgrade path, Homebrew package lookup, and legacy top-level entrypoint
cleanup in `scripts/install-extensions.sh`; and the tests that cover them (`scripts/skills-catalog.test.mjs`,
`scripts/skills-patch-entrypoint.test.mjs`, `scripts/install-extensions.test.mjs`). The sync at `502c13a0` adds, as
copied code, the `pi-overlay/` TypeScript source for the 0.85.1 `/skills` patch, the `scripts/build-pi-patch.mjs`
generation pipeline and its tests, and the `patch-drift` CI workflow. The sync at `867d931e` adds, as copied code, the
serialized persisted-skill updates, bare-name and relative-path normalization, the `pre-lock` 0.85.1 upgrade manifest,
and their tests; it also removes the pi 0.84.2 and 0.84.4 patch sets, as upstream does. This fork regenerates the 0.85.1
artifacts from its own overlay, which keeps the fork's `commandNeedsProjectTrust` change, and applies the same overlay
change to its fork-only 0.87.1 patch.

What was intentionally not adopted: upstream's removal of the router and vendored OpenTelemetry extensions from the
installer and documentation; upstream's dependency overrides and scripts where this fork carries its own; and upstream's
subagent fallback effort handling, where this fork keeps its own explicit model and effort resolution. From `867d931e`,
the fork did not adopt upstream's regenerated 0.85.1 artifact bytes, which its overlay does not reproduce, or its
single-version catalog-test layout with hard-coded `pre-validation-` and `pre-lock-` blocks; the fork's test keeps its
per-version loop and upgrades every recorded state.

The upstream pi 0.84.4 and 0.85.1 development package bumps were held back from the sync at `bc127ebf` because the
router's cost tests pin the model registry. Issue #64 later matched upstream's 0.85.1 versions after a separate router
evidence review; only the version numbers are shared with upstream.

## Pi 1.1.0 supported-install discovery and registry refresh

- Source: [Pi installer](https://pi.dev/install.sh) and `@earendil-works/pi-coding-agent@1.1.0` /
  `@earendil-works/pi-ai@1.1.0`
- Canonical repository: <https://github.com/earendil-works/pi>
- Package revision reviewed: `abe508e1b89912adde45528136c3221eb69acdd7` (`v1.1.0`); installer fetched 2026-10-08
- Declared package license: MIT; the fetched standalone installer does not declare a separate license

Conceptual use: `scripts/install-extensions.sh` independently follows the managed launcher's `install/current-version`
and `install/releases/<version>/node_modules/@earendil-works/pi-coding-agent` layout. The layout was checked against Pi
1.1.0's published `dist/package-manager-cli.js`. Package identity and the minimum supported version are checked before
installation. No installer code was copied; Pi's downloads, installation, self-update, release retention, runtime
marker, and shell-profile machinery were not adopted.

The router registry tests use the published 1.1.0 catalog's Azure Sol absence and existing cache-write rates as
observations, without copying generated registry code or changing routing policy. The entrypoint test's five-line
compile-cache loader is adapted from Pi 1.1.0's MIT-licensed `dist/bundle/cli.js` and verified byte-for-byte against its
baseline checksum; the runtime and RPC behavior exercised comes from this repository's existing wrappers. Pre-1.0.1
patch artifacts and overlays were removed; historical attribution above remains for shared ideas and code.

## XState v5 and fast-check (router lease ownership and race testing)

- XState: <https://github.com/statelyai/xstate>, npm `xstate@5.33.2`, MIT; reviewed the installed package's declarations
  and [actor](https://stately.ai/docs/actors) / [invocation](https://stately.ai/docs/invoke) documentation on
  2026-10-07. Consumed as an ordinary runtime dependency, with no upstream source copied or modified.
- fast-check: <https://github.com/dubzzz/fast-check>, npm `fast-check@4.10.2`, MIT; reviewed installed scheduler/model
  runner declarations and [race testing documentation](https://fast-check.dev/docs/advanced/race-conditions/) on
  2026-10-07. Consumed as a development dependency, with no upstream source copied or modified.

Conceptual use: XState's synchronous actor transitions, guarded statecharts, and cancellable promise children provide
one lease owner and a secondary classifier scoped to the builder's review family. fast-check generates JSON inputs,
state-transition sequences, and adversarial schedules for actual router handlers and their ledger/model waits. The
machine, adapter integration, and properties are original code. We did not adopt XState's persisted snapshot format, v6
alpha APIs, a global asynchronous handler queue, or make the telemetry ledger a state source. We did not copy fast-check
examples or its implementation; the existing Node test runner remains in place.
