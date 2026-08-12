# Attribution

## Subagent implementations

The subagent extension in [`extensions/subagents`](extensions/subagents) was informed by the two implementations
identified by the project owner. The implementation in this repository is original code, but it deliberately carries
forward architectural ideas and operational lessons from both projects.

## `nicobailon/pi-subagents`

- Repository: <https://github.com/nicobailon/pi-subagents>
- Local revision reviewed: `315e1eb1482c4ac2d912a8d95aac4287dc7e60ac`
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
- Local revision reviewed: `c161865a0e8ca12f406041c263ea6c2ca35c74d5` (`0.14.1`)
- License: MIT

This package was reviewed after the initial implementation as a source of possible follow-up ideas. The review
considered its in-process SDK sessions, background concurrency queue, graceful turn limits, result/steering tools,
conversation viewer, context-usage statistics, compact tool-description mode, model-scope guardrail, and resumable
sessions.

Follow-up work adopted two conceptual patterns: explicit, bounded result waiting and richer inspection statistics
(tokens, cost, context utilization, compactions, and active tool). They were implemented as original code inside the
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

Use: published per-token list rates; cache read/write billing ratios; default and one-hour TTL behavior; GPT-5.6's
explicit-breakpoint, minimum-prefix, and cache-usage-reporting behavior; and the exclusion of cache-read tokens from
input-token rate-limit quotas. The operator's private 17% discount was **not** derived from AWS documentation: it is a
separately confirmed contract term, and this repository uses the public pricing page only as its list-price basis.
Provisioned-throughput and commitment pricing were intentionally not adopted.

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

Use: automatic direct-route caching, in-memory inactivity/maximum retention, extended retention, and minimum-prefix
behavior. These facts document a possible cache-hit-rate difference from Bedrock; they are not used as token-price
claims. No SDK or example code was copied.

## LLM effectiveness research corpus and its upstream benchmark sources

The router's bootstrap priors in [`extensions/router/core/evidence.ts`](extensions/router/core/evidence.ts) and
[`specs/routing-layer/model-evidence-2026-07-25.json`](specs/routing-layer/model-evidence-2026-07-25.json) are derived
from a local research corpus and the public benchmark captures it aggregates.

- Source: local `llm-effectiveness` research corpus (`~/outputs/llm-effectiveness`), normalization version `2.0`
- Revision reviewed: capture dated 2026-07-25, spend data through 2026-07-19
- License: internal working data; not redistributed by this repository

Use: numeric priors (deterministic pass rate, hard-task pass rate, regression-breakage rate, partial credit on failure,
repeat reliability, wall time, agent steps, p90 peak context, cost per pass) were derived from that corpus's
`analysis/router_capability_slices.py` output and its `ROUTING_LEARNINGS.md` interpretation, then transcribed as typed
data with per-row provenance. No corpus code was copied into this repository.

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

## Pi documentation and examples

- Source: `@earendil-works/pi-coding-agent`
- Canonical repository: <https://github.com/earendil-works/pi> (`packages/coding-agent`)
- Releases reviewed: `0.80.6`, `0.82.0`, `0.82.1`, `0.83.0`, and `0.84.1`
- License declared by the package: MIT

Ideas and API patterns used:

- Extension tool registration, lifecycle shutdown hooks, resource discovery, and TUI tool rendering.
- Runtime active-tool selection through `getActiveTools()` / `setActiveTools()`, used to expose safety validators only
  during the lease phases that can accept them.
- SDK `AgentSession.compact()` with custom instructions and in-memory sessions.
- RPC JSONL framing and the `prompt`, `steer`, `follow_up`, `abort`, state, and event protocols.
- Model-registry authentication, fuzzy CLI-equivalent model resolution, thinking-level capability maps, and normal child
  resource inheritance.
- Pi's thinking-level clamp policy (prefer the nearest supported level above the request, fall back downward only when
  necessary) is a conceptual adaptation, reimplemented in `extensions/subagents/helpers.ts`; no Pi code was copied.
  `supportedThinkingLevels` additionally narrows OpenAI's direct GPT-5.6 levels beyond what Pi's generated model
  metadata declares, because the live endpoint rejects `minimal` and `max`. Pi's own permissive handling of those two
  levels is intentionally not adopted.
- Pi's bundled subagent and custom-compaction examples as reference implementations for process invocation, output
  bounds, and compaction setup.

Major pieces intentionally not adopted include Pi's full interactive mode, session-replacement runtime, prompt-template
workflows, custom provider implementations, and bundled role-based subagent profiles. No Pi source file or example was
copied verbatim; the extension is original code using Pi's published APIs and adapting the documented architectural
patterns.

### Router start-mode scoping (`extensions/router/core/start-mode.ts`)

The router's start-mode configuration reuses the repository-identity scoping mechanism introduced by this repository's
version-pinned pi skills patch ([`patches/pi-0.83.0/skills.patch`](patches/pi-0.83.0/skills.patch), applied to
`@earendil-works/pi-coding-agent@0.83.0`, MIT), which itself extends pi's skills configuration.

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

- Sources: `shell-quote` (<https://github.com/ljharb/shell-quote>, version `1.10.0`, MIT) and `shlex`
  (<https://github.com/rgov/node-shlex>, version `3.0.0`, MIT).
- Both are consumed as ordinary npm dependencies by `extensions/router/core/shell.ts`. No code from either package was
  copied or modified, and both ship their own type declarations.

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
