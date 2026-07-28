# Model-aware router

A task-leased, model-aware routing extension for pi. It classifies semantic task features, applies deterministic
eligibility/ranking policy, selects a versioned model prompt profile, and records an audit trail.

The extension starts in **shadow mode**: it logs and displays the route but does not change the model, effort, or system
prompt. This is intentional.

## Repository contract

The router has no dependency on an untracked design document or local conversation export. Its checked-in authorities
are:

- the [functional specification](../../specs/routing-layer/SPEC.md) and
  [source basis](../../specs/routing-layer/source-basis.md);
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
  `submit_safety_review` before the lease becomes `authorized_execution`. Rejection, missing evidence, reviewer failure,
  plan change, new user input, compaction, session change, or manual model/effort override cannot authorize execution.
- Other high-risk reversible non-code work consults a read-only advisor before acting and receives a completion review
  afterward. Advice is explicitly not authorization; cautionary advice is carried back to the tracked worker.
- Ordinary and non-destructive work is unchanged.

Generated authorization, advisory, and completion reviews have explicit `review` lifecycle state, a known tracked
builder, and two non-builder-vendor attempts; they never fall back to the builder for a verdict. Standalone
user-requested reviews are orthogonal ordinary leases: they inspect a bounded local or pull-request delta, classify its
scope/languages/complexity/risk/horizon/context/tool needs, and use feature-based review routing. They do not inherit
the current lease, invent a builder, become read-only merely because another task preceded them, or trigger recursive
automatic review. They may perform explicitly requested external operations such as posting review comments.

`PI_ROUTER_MODE=shadow|active|off` controls the initial mode when a session has no persisted router state. The default
is `shadow`. The routing enablement mode selected with `/route shadow|active|off` is carried through `/clear`; only the
mode is preserved, not the task lease, selected model, or effort. Other new sessions still use `PI_ROUTER_MODE` when
they have no persisted router state.

Alternatively, create `~/.pi/agent/router-config.json`:

```json
{
  "startMode": "active"
}
```

Precedence: `PI_ROUTER_MODE` environment variable > config file > built-in default (`shadow`).

## Data and telemetry

The lease is persisted as pi custom session entries. Local audit events are appended to:

```text
~/.pi/agent/router-telemetry/events.jsonl
```

Set `PI_ROUTER_TELEMETRY_PATH` to override the JSONL location (useful for isolated tests). When `pi-telemetry-otel` is
installed separately, router spans attach through its global Symbol registries. The router has no additional runtime
dependencies and works without OTel.

## Real Bifrost evaluation

Run `npm run test:eval:real`. The harness prefers already-exported `BIFROST_BASE_URL` plus `BIFROST_VIRTUAL_KEY`, then
fills missing values from the repository-local, gitignored `.env`. Start from `.env.example`; ordinary `npm test`
explicitly skips real-provider calls so local credentials do not make quality checks costly or non-deterministic.

## Model scope and endpoint health

The router chooses only from models the operator has scoped in through `enabledModels`, the same set pi's model selector
offers. Policy declares a logical model and an effort; concrete endpoints are resolved from the live registry, so all
spellings of one model (Bedrock region profiles, resale catalog IDs, gateway paths) group together and an availability
failure retries the same model before the router changes models.

Set `PI_ROUTER_MODEL_SCOPE` to a comma-separated pattern list to pin the scope for a run.

Probe which scoped endpoints actually work on this machine, then let routing exclude the broken ones:

```sh
node scripts/probe-scoped-models.mjs           # writes ~/.pi/agent/router-endpoint-health.json
node scripts/probe-scoped-models.mjs --dry-run # list the scope without calling anything
```

Recurring failures (4xx and unusable responses) are excluded until re-probed. Transient failures (5xx, timeouts) and
unprobed endpoints stay eligible. Override the record location with `PI_ROUTER_ENDPOINT_HEALTH_PATH`.

## Safety behavior

- Only user input can trigger classification or a new lease.
- New sessions, post-compaction turns, upstream-ref changes, and forks are hard boundaries.
- Explicit model or effort changes bypass automatic model selection until the next task boundary, but never convert a
  preflight into authorization; on a safety-managed lease they invalidate authorization and keep mutation blocked until
  active routing is safely restored.
- Preflight, advisory-pending, and generated-review phases use a deterministic read-only tool allowlist. Unknown tools
  and shell composition are blocked. Authorized execution additionally rejects mutating tool names absent from the
  reviewed plan.
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
