# Model-aware router

A task-leased, model-aware routing extension for pi. It classifies semantic task features, applies deterministic
eligibility/ranking policy, selects a versioned model prompt profile, and records an audit trail.

The extension starts in **shadow mode**: it logs and displays the route but does not change the model, effort, or system
prompt. This is intentional.

## Repository contract

The router has no dependency on an untracked design document or local conversation export. Its checked-in authorities
are:

- the [functional specification](../../specs/routing-layer/SPEC.md),
  [source basis](../../specs/routing-layer/source-basis.md), and generated-table
  [model and endpoint evidence](../../specs/routing-layer/model-evidence-2026-08-11.md);
- the executable [feature](core/features.ts), [synopsis](core/synopsis.ts), [policy](core/policy.ts), and
  [prompt-profile](core/profiles.ts) contracts;
- the [architecture decisions](../../specs/routing-layer/decisions.md),
  [implementation record](../../specs/routing-layer/implementation-plan.md), and
  [evaluation contract](../../specs/routing-layer/eval.md).

The source-basis document records the historical inputs that were incorporated and links the public provider, benchmark,
Bifrost, and telemetry references. If prose and executable contracts diverge, treat that as a repository bug; do not
reconstruct behavior from the historical export.

## Commands

- `/route` — show the current mode, task lease, model, effort, profile, and attempt.
- `/route shadow|active|off` — change mode for this session.
- `/route reset` — clear the lease; the next user message starts a new task.
- `/route accept|reject` — label the most recent attempt for telemetry maturity.
- `/route fail availability|quality|deterministic_verification` — apply the authorized sequential fallback. Ordinary
  routes continue through every eligible, policy-authorized provider endpoint before restoring the prior selection.

`/route off` is an immediate bypass for this extension within the running session. It discards any pending route,
removes every router-only tool (including `submit_implementation_plan`), and stops classification, prompt compilation,
automatic model/effort changes, manual selection tracking, lifecycle blocking and evidence collection,
fallbacks/reviews, `/route accept|reject|fail`, and all router telemetry. It aborts pending secondary reconciliation,
keeping any low-confidence safety latch for the dormant lease. Other routing work already in flight is not cancelled,
but its result is discarded: it installs no lease, applies no model or effort, returns no prompt, re-exposes no tools,
and submits no new telemetry, even if routing is re-enabled before it finishes. Telemetry writes and spans already
accepted before off may still finish. The last lease remains dormant so `/route active` can safely restore the existing
lifecycle; while off, the router does not restrict models, reasoning efforts, ordinary tools, or turns.

Planning routes must call `submit_implementation_plan`; the tool validates the PR dependency DAG, acceptance criteria,
rollout, and rollback. A normal response that omits the tool gets one same-lease corrective follow-up before the bounded
fallback policy applies. A request to start implementation always receives a new lease.

Safety is an explicit persisted lease lifecycle, not an inference from archetype or parent linkage:

- High-risk code builders implement first, record a repository delta and passing deterministic checks, and then receive
  a read-only, provider-independent completion review.
- High-risk, potentially irreversible external/repository/runtime actions start in a non-mutating `preflight` phase.
  `submit_action_plan` validates concrete targets, steps, effects, preconditions, verification, rollback, abort
  conditions, and tool names. A different-vendor reviewer must approve the exact task/plan fingerprint through
  `submit_safety_review` before the lease becomes `authorized_execution`. Each validator is active in Pi's model-facing
  tool set only during the lifecycle phase that accepts it, so ordinary work cannot accidentally call a lease-only tool.
  Rejection, missing evidence, reviewer failure, plan change, new user input, compaction, session change, or manual
  model/effort override cannot authorize execution.
- Other high-risk reversible non-code work consults a read-only advisor before acting and receives a completion review
  afterward. Advice is explicitly not authorization; cautionary advice is carried back to the tracked worker.
- Unattended or indefinite loops that repeatedly create external effects across repositories or services are treated as
  broad-impact authorization work even when each individual effect is reversible or the classifier reports medium risk.
- Ordinary and non-destructive work is unchanged.

Manual model/effort selection preserves that explicit selection, not the semantic identity of the previous task. A
nontrivial subsequent request still receives continuity classification; when it is a new task, the router creates a
fresh lease and safety lifecycle while carrying the selected model/effort into that lease.

## Continuity fast paths and classifier deadline

For ordinary, nonqueued interactive user input with an existing lease, the boundary gate handles only two narrow prompt
classes without an LLM call: anchored confirmations such as `continue` or `go ahead`, and an anchored allowlist of
same-task implementation operations such as rerunning checks, fixing reported failures/findings, or committing the
completed change. The operation shortcut applies only to a mutation-capable code-builder lease whose policy archetype
mutates the repository. Within that ordinary-input path, hard boundaries precede prompt matching; explicit topic
changes, planning-to-implementation transitions, incompatible planning/review/read-only leases, and topic-bearing near
matches still create or classify a boundary. Queued steer/follow-up input is a separate continuation path evaluated
before pending hard boundaries, because it is delivered into a turn that is already running; that path is delivery-based
and applies to queued input of any origin, including an extension's `sendUserMessage`. It skips semantic reevaluation,
not capability checks: images that the leased model cannot accept still force a new task, because no route can serve
that turn otherwise. These shortcuts retain a lease; they never create authorization or bypass its lifecycle/tool gates.

Extension-generated input is not privileged. pi marks a turn `source: "extension"` when any extension calls
`sendUserMessage`, and while the agent is idle such input runs the ordinary prompt path with no `streamingBehavior`, so
it is indistinguishable from typed input apart from the label. It is therefore evaluated exactly like ordinary input: it
cannot outrank a pending hard boundary, cannot silently inherit the active lease, and invalidates a standing execution
authorization the same way a typed message does. The router's own continuations (authorized execution, advisory, and
post-fallback) are custom `model-router-context` messages, which never surface as an input event and so keep their lease
without relying on any source exemption.

Every router-level fresh-task or continuity classification is bounded by router-owned stage deadlines. Rather than
sharing a single combined timer across primary classification and escalation, each classification stage of a synchronous
classifier invocation receives an independent timeout budget configured in code
([`CLASSIFICATION_STAGE_TIMEOUT_MS`](index.ts)). That constant owns fresh-task primary classification and continuity
classification, which still escalates primary to secondary inside the same invocation, so the secondary stage there
starts a fresh budget.

There are two timeout owners, and changing one does not affect the other. Background fresh-task secondary reconciliation
runs as a separate classifier invocation bounded by the configurable
[`secondaryGracePolicy.secondaryDeadlineMs`](core/reconciliation.ts), not by `CLASSIFICATION_STAGE_TIMEOUT_MS`; the
companion `maxGraceMs` bounds only how long the router pauses before releasing the first provider request, after which
the secondary classifier keeps running until its own deadline and may reconcile at a later safe boundary. Because the
two budgets differ, every `secondary_reconciliation` record states the budget it was running against in
`secondaryDeadlineMs`; a run that did not succeed also records `secondaryOutcome`, `secondaryWallLatencyMs`, and the
bounded `secondaryErrorCategory`, plus `secondaryEnforcedBudgetMs` and `secondaryDeadlineStage` when a router-owned
deadline elapsed. A `secondary_timeout` is therefore attributable to a budget without cross-referencing the paired
`classifier_invocation`. The router passes an `AbortSignal` through schema attempts and concrete endpoint calls for the
active stage. A stage deadline aborts the in-flight call; within an active stage, any `AbortError` or `TimeoutError` is
terminal, so the classifier does not retry the attempt or advance to another endpoint in that stage. On a continuity
failure the current lease, model, effort, and profile remain selected. On a fresh-task failure the router does not
create a route from synthetic evidence and keeps the current model/effort (and an existing lease, if present). Concrete
timeout thresholds can be inspected directly in [`index.ts`](index.ts) and [`telemetry.ts`](telemetry.ts).

Generated authorization, advisory, and completion reviews have explicit `review` lifecycle state, a known tracked
builder, and at least two eligible non-builder-vendor attempts; they never fall back to the builder for a verdict.
Standalone user-requested reviews are orthogonal ordinary leases: they inspect a bounded local or pull-request delta,
classify its scope/languages/complexity/risk/horizon/context/tool needs, and use feature-based review routing. They do
not inherit the current lease, invent a builder, become read-only merely because another task preceded them, or trigger
recursive automatic review. They may perform explicitly requested external operations such as posting review comments.

## Start mode and enablement continuity

Enablement is sticky. The mode selected with `/route shadow|active|off` survives `/compact` and `/clear`, and by default
it also survives quitting pi: the next session starts in the mode that was in force when the router last stopped. Only
the mode is carried across a session boundary: `/clear`, a fork, and a fresh launch begin with no lease, model, or
effort of their own.

`/compact` is a deferred boundary rather than an immediate discard. Any standing execution authorization is invalidated
at once, and the router records a pending `post_compaction` boundary while keeping the lease, model, and effort in
place. The next ordinary user message hits that boundary and starts a new task; input queued into a turn that is still
running continues the existing lease instead. If that first post-compaction classification fails or times out, the
router keeps the existing lease and selection rather than routing on incomplete evidence, and the pending boundary stays
in force for the next ordinary message.

A session that already carries its own router state keeps it. Start-mode configuration only decides what a session with
no router history starts in (a fresh launch, `/clear`, or a fork).

Configure the start mode with `startMode`, which accepts `last` (the default), `off`, `shadow`, or `active`:

- Global — `~/.pi/agent/router-config.json`:

  ```json
  {
    "startMode": "last"
  }
  ```

- Per repository — `~/.pi/agent/repo-router-config.json`, keyed by repository identity:

  ```json
  {
    "github.com:nigel-upstart/pi-buildout": { "startMode": "active" },
    "local:~/repos/private-tool": { "startMode": "off" }
  }
  ```

Repository keys use the same format as pi's repository-scoped skills configuration: resolved from git remotes in the
order `upstream`, `origin`, then the first configured remote, with remote URLs normalized so
`git@github.com:org/repo.git`, `https://github.com/org/repo`, and `ssh://git@github.com/org/repo.git` all become
`github.com:org/repo`. With no usable remote, the key is `local:<repo-root-relative-to-$HOME>`.

Precedence: `PI_ROUTER_MODE` environment variable > repository entry > global config file > built-in default (`last`).
`PI_ROUTER_MODE` also accepts `last`. Malformed values are ignored rather than treated as an enablement request, so a
bad config can never switch routing on.

The mode in force is recorded in `~/.pi/agent/router-last-mode.jsonl` (override with `PI_ROUTER_LAST_MODE_PATH`)
whenever it changes and at session shutdown. The file is an append-only log of one JSON record per line, keyed by
repository, so several pi processes stopping at once cannot drop each other's records; the newest record for the current
repository wins on read, and the newest record of any repository is the machine-wide fallback. The log is compacted to
the newest record per repository once it passes a few hundred lines. Recording is best-effort — if the file cannot be
written, the next session falls back to the configured or built-in default. When `startMode` is `last` and nothing has
been recorded, the router starts in `shadow`.

## Data and telemetry

The lease is persisted as pi custom session entries. Local audit events are appended to:

```text
~/.pi/agent/router-telemetry/events.jsonl
```

Set `PI_ROUTER_TELEMETRY_PATH` to override the JSONL location (useful for isolated tests). All event kinds share one
store-wide queue, preserving invocation order and making exactly one persistence attempt per accepted event. Each
`append()` caller waits at most **250 ms**, including time queued behind an earlier write. A deadline does not start a
second write or abandon the queued persistence promise: the attempt may settle later, its rejection is consumed, and no
later event can overtake it. A persistence rejection or caller deadline disables telemetry-driven automatic routing for
the session; `active` fails safe to `shadow`, while `shadow` stays observational. The failure is reported once and late
settlement cannot retry the event, re-enable routing, or apply the fail-safe twice.

While telemetry is healthy, each router-level classification request makes one privacy-safe `classifier_invocation`
append attempt with `invocationCount: 1`. Its request fields are `purpose` (`fresh_task` or `continuity`), `outcome`,
`resolution`, `wallLatencyMs`, `timedOut`, and `cancelled`, plus aggregate attempt counts, per-stage counts, sanitized
attempt entries, and an optional bounded error category. When the router's own deadline elapsed
(`errorCategory: "deadline"`), the record also names the stage that held the budget in `deadlineStage` and the budget it
enforced in `stageBudgetMs`, so no consumer has to infer the stage from whichever attempt was left `incomplete`. Both
fields are absent on success and on a provider-thrown `transport_timeout`, which is the transport's deadline rather than
the router's. Attempt entries can contain only stage/try/outcome and validated provider/model/latency identifiers;
prompts, synopses, classifier evidence, and free-form errors are never included. Count request volume and rates only
from `classifier_invocation`. The legacy `classifier_attempt` event is a non-additive downstream diagnostic emitted only
when a completed classification proceeds into new-lease routing; zero or several can belong to one request. Never sum
the two kinds.

When `pi-telemetry-otel` is installed separately, `router.classify` and `router.classify_continuity` spans attach
through its global Symbol registries. They receive bounded `router.classifier.*` summary attributes, one
`router.classifier.attempt` event per observed attempt, and a `router.classifier.completed` event, with no prompt,
synopsis, evidence, or free-form error text. A router deadline additionally exports `router.classifier.deadline_stage`
and `router.classifier.stage_budget_ms`. The router has no additional runtime dependencies and works without OTel.

## Real Bifrost evaluation

Run `npm run test:eval:real`. The harness prefers already-exported `BIFROST_BASE_URL` plus `BIFROST_VIRTUAL_KEY`, then
fills missing values from the repository-local, gitignored `.env`. Start from `.env.example`; ordinary `npm test`
explicitly skips real-provider calls so local credentials do not make quality checks costly or non-deterministic.

## Model scope and endpoint health

The router chooses only from models the operator has scoped in through `enabledModels`, the same set pi's model selector
offers. Policy declares a logical model and an effort; concrete endpoints are resolved from the live registry. Eligible
spellings of one model (Bedrock region profiles, resale catalog IDs, gateway paths) are ordered cost-first as one group,
and an endpoint failure tries the rest of that group before the router changes models.

Set `PI_ROUTER_MODEL_SCOPE` to a comma-separated pattern list to pin the scope for a run.

Probe which scoped endpoints actually work on this machine, then let routing exclude the broken ones:

```sh
node scripts/probe-scoped-models.mjs           # writes ~/.pi/agent/router-endpoint-health.json
node scripts/probe-scoped-models.mjs --dry-run # list the scope without calling anything
```

Recurring failures (4xx and unusable responses) are excluded until re-probed. Transient failures (5xx, timeouts) and
unprobed endpoints stay eligible. Override the record location with `PI_ROUTER_ENDPOINT_HEALTH_PATH`.

## Cost-first endpoint ordering

Eligibility is resolved before ordering. Every token-billed endpoint for the selected logical model is ordered by
ascending weighted effective cost, then first-party/gateway/resale tier, model-ID specificity, and exact provider/model
ID. Tier breaks only an equal-cost tie; it never overrides a genuinely cheaper endpoint. Effective cost uses the
endpoint's own list rates:

```text
(0.25 * input + 0.75 * output) * provider weight
```

The built-in route weights are:

| Provider                  |  Weight | Basis      | Purpose                                                         |
| ------------------------- | ------: | ---------- | --------------------------------------------------------------- |
| `amazon-bedrock`          | 1.00001 | preference | slightly behind first-party routes when list rates match        |
| `openai-codex`            |     1.0 | preference | preferred first-party subscription route                        |
| `anthropic`               |     1.0 | preference | neutral first-party route                                       |
| `google`, `google-vertex` |     1.0 | preference | neutral first-party routes; direct Google is review-only        |
| `bifrost`                 |     1.0 | preference | neutral self-operated gateway                                   |
| `openai`                  |   1.001 | preference | just behind `openai-codex` when list rates match                |
| unknown provider          |    1.01 | preference | trails neutral known routes when list rates match               |
| `github-copilot`          |     n/a | —          | excluded from token-cost comparison and ordered last; see below |

A `contract` basis asserts an actual price adjustment; a `preference` basis asserts ordering only and makes no price
claim.

Configure overrides in project `.pi/settings.json` or user `~/.pi/agent/settings.json` under `routerProviderWeights`, or
set `PI_ROUTER_PROVIDER_WEIGHTS` to a JSON object. A number declares a `preference` weight; an object declares both
fields explicitly:

```json
{
  "routerProviderWeights": {
    "amazon-bedrock": 1.00001,
    "openai": 1.001
  }
}
```

```sh
export PI_ROUTER_PROVIDER_WEIGHTS='{"amazon-bedrock":1.00001,"openai":1.001}'
```

Precedence is resolved independently for each provider: environment, then project, then user, then built-in. Weights
must be finite numbers from `0.5` through `2.0`, inclusive. An invalid selected entry records a non-sensitive rejection
and uses neutral `1.0`; it does not recover a lower-precedence value for that provider.

Bedrock's `1.00001` preference applies a minimal ordering penalty to its registry list rates; the router claims no
private discount. When unweighted list rates tie a manufacturer's route for the same model, the first-party endpoint is
tried first and Bedrock remains an availability fallback. Cache-write rates are classified explicitly: `priced_write`
for a positive write rate, `no_write_line_item` when reads are priced but writes have no separate charge, and
`caching_unpriced` when both read and write rates are zero (unpriced or unsupported). GitHub Copilot's flat-rate token
prices are capability proxies rather than marginal billed costs, so Copilot has no effective-cost value and follows all
eligible token-billed routes.

Bedrock `gpt-6-sol`, `gpt-5.6-terra`, and `gpt-6-luna` are excluded above 272,000 estimated finished tokens until their
registry entries supply a long-context rate; the router never extends their short-context rates beyond that boundary.
Residency remains a scope choice, not an ordering preference: scope in only the regional inference profiles permitted
for the workload and scope out Global or other profiles that violate the requirement. Cost ordering never adds or
revives an out-of-scope endpoint.

Direct `google` endpoints are eligible only for `code_review`, preserving the low direct-Gemini request quota for an
independent reviewer. Gemini 3.8 Flash at high effort leads the Google review ladder when its exact ID is available;
`google-vertex` and other scoped surfaces may still serve ordinary older-Gemini policy entries.

Median repository implementation uses Opus 5.5 at medium as the generation-forward default and keeps GPT-6 Sol high as
its cross-provider challenger. GPT-6 Luna/Sol and Opus 5.5 intentionally inherit their GPT-5.6 Luna/Sol and Opus 5
bootstrap priors: this is an explicit same-price, no-regression assumption until local telemetry matures, not direct
benchmark evidence. Measured language-specific routes still override that default. GPT-6 Astra high uses its refreshed
direct measurements (with Sol-high proxies only for the three omitted reliability/context fields) and appears only in
high-intelligence planning, highest-risk advisory, and independent-review ladders. The bounded read-only classification
and extraction ladders retain MiniMax M2.5 and GPT-OSS 120B and add Kimi K2.5 plus Kimi K2 Thinking. Kimi remains
structurally barred from mutating work because its current quality evidence is single-attempt.

Endpoint tiers remain in route and lease records and break equal-effective-cost ties. Every endpoint for the selected
logical model and effort still precedes every different-model fallback.

## Safety behavior

- Only user input can trigger classification or a new lease.
- New sessions, post-compaction turns, upstream-ref changes, and forks are hard boundaries.
- Explicit model or effort changes bypass automatic model selection until the next task boundary, but never convert a
  preflight into authorization; on a safety-managed lease they invalidate authorization and keep mutation blocked until
  active routing is safely restored.
- Preflight, advisory-pending, and generated-review phases use a deterministic read-only tool allowlist. Unknown tools
  and shell composition are blocked. A `bash` command is lexed into argv (`core/shell.ts`) and then checked against
  per-binary allowlists of subcommands and options, so a permitted binary cannot be handed a writing option, a second
  command, substitution, or a malformed quote. Authorized execution additionally rejects mutating tool names absent from
  the reviewed plan.
- Unknown, unavailable, over-context, unsupported-effort, or unprofiled candidates are excluded.
- Executing work across a dependent pull-request stack is distinct from planning one. The stack route is restricted to
  exact current-generation IDs (`gpt-6-sol/high` and `claude-opus-5-5/high`, plus their same-model availability
  backups), so routing cannot silently hand stack mutation to older generations or the broader Sonnet tier.
- Effort is capped at each model family's measured saturation tier, low-effort tiers with high measured regression
  breakage are barred from repository-mutating routes, and candidates whose measured p90 peak context exceeds the window
  headroom are excluded before scoring.
- A validated provider-diverse classifier result may serve as failover, but complete classification failure retains the
  current selection instead of manufacturing evidence for a premium route.
- The request remains a native user message and is never paraphrased into system policy.
