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
matches still create or classify a boundary. Extension-generated input and queued steer/follow-up input are separate
unconditional continuation paths evaluated before pending hard boundaries, because they remain part of the already
running lease. These shortcuts retain a lease; they never create authorization or bypass its lifecycle/tool gates.

Every router-level fresh-task or continuity classification has one router-owned **11-second wall-clock deadline**. The
router passes one `AbortSignal` through schema attempts and concrete endpoint calls. A router deadline aborts the
in-flight call; any `AbortError` or `TimeoutError` is terminal, so the classifier does not retry the attempt, try
another endpoint, or start/continue secondary escalation. On a continuity failure the current lease, model, effort, and
profile remain selected. On a fresh-task failure the router does not create a route from synthetic evidence and keeps
the current model/effort (and an existing lease, if present).

Generated authorization, advisory, and completion reviews have explicit `review` lifecycle state, a known tracked
builder, and two non-builder-vendor attempts; they never fall back to the builder for a verdict. Standalone
user-requested reviews are orthogonal ordinary leases: they inspect a bounded local or pull-request delta, classify its
scope/languages/complexity/risk/horizon/context/tool needs, and use feature-based review routing. They do not inherit
the current lease, invent a builder, become read-only merely because another task preceded them, or trigger recursive
automatic review. They may perform explicitly requested external operations such as posting review comments.

## Start mode and enablement continuity

Enablement is sticky. The mode selected with `/route shadow|active|off` survives `/compact` and `/clear`, and by default
it also survives quitting pi: the next session starts in the mode that was in force when the router last stopped. Only
the mode is carried; the task lease, selected model, and effort are always discarded at those boundaries, so the next
user message starts a new task.

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
attempt entries, and an optional bounded error category. Attempt entries can contain only stage/try/outcome and
validated provider/model/latency identifiers; prompts, synopses, classifier evidence, and free-form errors are never
included. Count request volume and rates only from `classifier_invocation`. The legacy `classifier_attempt` event is a
non-additive downstream diagnostic emitted only when a completed classification proceeds into new-lease routing; zero or
several can belong to one request. Never sum the two kinds.

When `pi-telemetry-otel` is installed separately, `router.classify` and `router.classify_continuity` spans attach
through its global Symbol registries. They receive bounded `router.classifier.*` summary attributes, one
`router.classifier.attempt` event per observed attempt, and a `router.classifier.completed` event, with no prompt,
synopsis, evidence, or free-form error text. The router has no additional runtime dependencies and works without OTel.

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
ascending weighted effective cost, then model-ID specificity, then exact provider/model ID. Effective cost uses the
endpoint's own list rates:

```text
(0.25 * input + 0.75 * output) * provider weight
```

The built-in route weights are:

| Provider                  | Weight | Basis      | Purpose                                                         |
| ------------------------- | -----: | ---------- | --------------------------------------------------------------- |
| `amazon-bedrock`          |   0.83 | contract   | 17% off published list price across every token class           |
| `openai-codex`            |    1.0 | preference | preferred first-party subscription route                        |
| `anthropic`               |    1.0 | preference | neutral first-party route                                       |
| `google`, `google-vertex` |    1.0 | preference | neutral first-party routes                                      |
| `bifrost`                 |    1.0 | preference | neutral self-operated gateway                                   |
| `openai`                  |  1.001 | preference | just behind `openai-codex` when list rates match                |
| unknown provider          |   1.01 | preference | trails neutral known routes when list rates match               |
| `github-copilot`          |    n/a | —          | excluded from token-cost comparison and ordered last; see below |

A `contract` basis asserts an actual price adjustment; a `preference` basis asserts ordering only and makes no price
claim.

Configure overrides in project `.pi/settings.json` or user `~/.pi/agent/settings.json` under `routerProviderWeights`, or
set `PI_ROUTER_PROVIDER_WEIGHTS` to a JSON object. A number declares a `preference` weight; an object declares both
fields explicitly:

```json
{
  "routerProviderWeights": {
    "amazon-bedrock": { "weight": 0.83, "basis": "contract" },
    "openai": 1.001
  }
}
```

```sh
export PI_ROUTER_PROVIDER_WEIGHTS='{"amazon-bedrock":{"weight":0.83,"basis":"contract"}}'
```

Precedence is resolved independently for each provider: environment, then project, then user, then built-in. Weights
must be finite numbers from `0.5` through `2.0`, inclusive. An invalid selected entry records a non-sensitive rejection
and uses neutral `1.0`; it does not recover a lower-precedence value for that provider.

The Bedrock operator adjustment covers input, output, cache reads, short cache writes, and 1-hour cache writes. Pi
prices a 1-hour write as `input * 2`, so applying the uniform weight to input covers that class as well. Cache-write
rates are classified explicitly: `priced_write` for a positive write rate, `no_write_line_item` when reads are priced
but writes have no separate charge, and `caching_unpriced` when both read and write rates are zero (unpriced or
unsupported). GitHub Copilot's flat-rate token prices are capability proxies rather than marginal billed costs, so
Copilot has no effective-cost value and follows all eligible token-billed routes.

Bedrock `gpt-5.6-sol` is excluded above 272,000 estimated finished tokens until its registry entry supplies a
long-context rate; the router never extends its short-context rate beyond that boundary. Residency remains a scope
choice, not an ordering preference: scope in only the regional inference profiles permitted for the workload and scope
out Global or other profiles that violate the requirement. Cost ordering never adds or revives an out-of-scope endpoint.

Endpoint tiers remain in route and lease records as diagnostic metadata only. Every endpoint for the selected logical
model and effort still precedes every different-model fallback.

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
  exact current-generation IDs (`gpt-5.6-sol/high` and `claude-opus-5/high`, plus their same-model availability
  backups), so routing cannot silently hand stack mutation to older generations or the broader Sonnet tier.
- Effort is capped at each model family's measured saturation tier, low-effort tiers with high measured regression
  breakage are barred from repository-mutating routes, and candidates whose measured p90 peak context exceeds the window
  headroom are excluded before scoring.
- A validated provider-diverse classifier result may serve as failover, but complete classification failure retains the
  current selection instead of manufacturing evidence for a premium route.
- The request remains a native user message and is never paraphrased into system policy.
