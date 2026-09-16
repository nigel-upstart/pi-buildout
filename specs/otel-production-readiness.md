# Pi OpenTelemetry production readiness

Status: **client implementation complete; backend policy verification remains external**.

This document is the operational contract for the repository-owned `extensions/otel` fork. The ownership decision,
adoption mechanics, and rollback origin are in [`otel-ownership-decision.md`](otel-ownership-decision.md).

## Supported launch paths

All supported Pi paths load the same installed extension and therefore use the same configuration resolver and health
state. A launcher must not carry a second telemetry implementation.

| Launch path                                    | Configuration and identity                                                                    | Verification                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Managed `upstart-dotfiles` `pi()` wrapper      | Managed `.pi/agent/settings.json`; wrapper appends `user.email` to `OTEL_RESOURCE_ATTRIBUTES` | Run one prompt, then `/otel status`                                          |
| Direct `pi` binary or mise shim                | Same managed settings; caller may set `OTEL_RESOURCE_ATTRIBUTES=user.email=...`               | Run one prompt, then `/otel status`                                          |
| Custom `PI_AGENT_DIR` installation             | Settings under that agent directory; installer copies the owned fork with `--with-otel`       | Launch that Pi installation, run one prompt, then `/otel status`             |
| Mid-session `/otel start` or `/otel connect`   | Command endpoint/protocol overrides resolved settings and rebuilds the scoped runtime         | `/otel status` after the first exported signal                               |
| `/clear`, `/reload`, and `/resume` transitions | The process is reused; session id and scoped providers are reset per lifecycle                | Confirm the new session id on spans/metrics and a new `pi.session.start` log |

`/otel status` is non-blocking. It reports:

1. whether the extension resolves enabled;
2. which signals resolve enabled;
3. whether the endpoint accepts a TCP connection; and
4. whether each exporter has attempted, failed, or successfully delivered a payload to that endpoint.

“Accepted” is intentionally narrow: the OTLP exporter received a successful response. Backend indexing and retention are
verified separately. Before an interaction, traces and metrics may correctly say `no export attempted yet`; the session
start log gives a logs-enabled deployment an immediate delivery signal.

Programmatic launchers can request the same snapshot by emitting `pi-otel:request-status` and consuming the resulting
`pi-otel:status` event. The payload contains `state` plus the per-signal health snapshot and never includes exporter
headers.

## Convention mapping

### Spans

| Pi lifecycle             | GenAI span            | Required dimensions                                                                  |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------ |
| Prompt/agent interaction | `invoke_agent pi`     | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=pi`, session keys           |
| Provider request         | `chat {model}`        | operation, provider, request/response model, token usage, provider cost when present |
| Tool execution           | `execute_tool {tool}` | operation, tool name/call id, error status, session keys                             |

Legacy `pi.*` names remain available through `spanNaming=legacy`. Managed production uses `genai` naming.

### Metrics

| Instrument                               | Type               | Convention status                       | Dimensions                                     |
| ---------------------------------------- | ------------------ | --------------------------------------- | ---------------------------------------------- |
| `gen_ai.client.operation.duration`       | histogram, seconds | GenAI semconv                           | system, operation, models, error, session      |
| `gen_ai.client.token.usage`              | histogram, tokens  | GenAI semconv                           | system, operation, models, token type, session |
| `gen_ai.client.tool.calls`               | counter            | extension-owned                         | system, tool, error, session                   |
| `gen_ai.client.tool_calls_per_operation` | histogram          | extension-owned                         | system, operation, models, session             |
| `gen_ai.client.cost.usd`                 | counter, USD       | custom; no GenAI cost instrument exists | system, operation, models, session             |

The session dimension means all three existing span keys: `pi.session.id`, `session.id`, and `gen_ai.conversation.id`.
They are omitted together for ephemeral sessions. `user.email` remains a resource attribute supplied by the managed
wrapper; Datadog promotes it onto metric series. Provider cost is recorded only when `usage.cost.total` is finite and
positive. The client never computes, estimates, or substitutes cost.

### Resource identity

`service.name`, `pi.cwd`, and caller-supplied resource attributes are shared across signals. A random
`service.instance.id` is present on traces and logs but omitted from metrics. This preserves concurrent-process identity
where it is useful without generating one metric series per Pi process.

## SDK coexistence

The fork constructs private `BasicTracerProvider`, `MeterProvider`, and `LoggerProvider` instances and takes instrument
handles directly from them. It does not register signal providers globally. If another SDK owns global providers, Pi
reports one informational coexistence message, emits through its private pipelines, and leaves the foreign SDK untouched
on shutdown.

The trade-off is deliberate: third-party automatic instrumentation does not implicitly join Pi's private provider. Pi's
own tree is explicitly parented, and shell propagation serializes the active Pi tool context to `TRACEPARENT` /
`TRACESTATE`, so the owned behavior does not depend on global providers.

## Datadog indexing and APM policy

The client policy is **export useful dimensions, index selectively**.

| Dimension                                 | Export                        | Metric indexing policy                                              |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| tool, model, operation, token type, error | yes                           | indexed                                                             |
| `user.email`                              | yes                           | indexed for cross-agent per-user cost/usage                         |
| session/conversation ids                  | yes                           | export-only by default; index only for a time-bounded investigation |
| `service.instance.id`                     | traces/logs only              | not present on metrics                                              |
| prompt, messages, tool arguments/results  | spans only under full capture | protected by trace retention/access policy; never metric tags       |

The repository does not own Datadog Metrics without Limits or APM ingestion configuration. Applying and proving that
configuration belongs in the Datadog/collector infrastructure repository. In particular, an accepted client export does
not prove that Pi spans are indexed as APM traces or that span-derived metrics are enabled.

Read-only verification commands:

```bash
pup --read-only metrics tags list gen_ai.client.tool.calls --from=30d --window-seconds=2592000
pup --read-only traces search --query='service:pi-coding-agent' --from=30d --limit=20
pup --read-only traces aggregate --query='service:pi-coding-agent' --from=30d \
  --compute='count' --group-by='resource_name'
```

Run these with Datadog read credentials. Any indexing change must be reviewed in the owning infrastructure repository,
then the same queries must show the expected indexed set and Pi span resources.

## Rollout and rollback

1. Run the OTel package typecheck, tests, and production-dependency audit.
2. Install with `scripts/install-extensions.sh --with-otel`; remove published Pi telemetry packages to avoid duplicate
   Pi lifecycle instrumentation.
3. Confirm managed settings resolve full capture, GenAI names, all intended signals, and the expected remote endpoint.
4. Launch through each supported path, complete a prompt/tool interaction, and require `/otel status` to show endpoint
   reachability plus an accepted delivery for every enabled signal.
5. Verify metric dimensions/cost and APM trace ingestion in Datadog with the read-only commands above.
6. Apply the reviewed Datadog indexing policy and confirm metric series are not split by `service.instance.id`.

Rollback is atomic at the managed-install layer: reinstall without `--with-otel`, restore the published package only if
telemetry continuity is required, and remove the owned extension directory. The published package reintroduces its 60
KiB cap, global-provider ownership, stale dependency train, old token keys, and reachability-only status; those are
known rollback degradations, not silent equivalence.

## Production-readiness issue disposition

| Issue                                      | Disposition                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| #35 metric session/identity dimensions     | Implemented in the owned extension; managed `user.email` remains a resource attribute from `upstart-dotfiles`         |
| #36 unbounded metric `service.instance.id` | Implemented by separate process and metric resources; traces/logs retain it, metrics omit it                          |
| #37 provider-reported cost metric          | Implemented as custom `gen_ai.client.cost.usd`; absent/non-positive provider values emit nothing                      |
| #38 coexistence with another OTel SDK      | Implemented with provider-scoped traces, metrics, and logs plus foreign-provider preservation tests                   |
| #39 Datadog indexing policy                | Client/export policy recorded here; backend application and verification remain with Datadog infrastructure ownership |
| #40 launch-path export verification        | Implemented through `/otel status`, `pi-otel:status`, and exporter callback health                                    |
| #41 Datadog APM trace ingestion            | Client emits and locally proves OTLP traces; definitive backend ingestion and span-metric decision remain external    |
