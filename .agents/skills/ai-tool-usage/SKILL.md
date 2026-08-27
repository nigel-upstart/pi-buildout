---
name: ai-tool-usage
description: >-
  Analyze AI tool usage in Datadog, Claude Code, Cowork and Codex MCP tools and Skills.
argument-hint: "<Datadog AI usage question and time range>"
disable-model-invocation: true
---

# AI Tool Usage

Analyze AI tool usage from Datadog logs and metrics. Prefer the `pup` CLI because its command syntax and output are
known and reproducible. If `pup` is not installed, use an available Datadog MCP to perform the equivalent Datadog Logs
Analytics or Metrics query. Do not invent Datadog MCP tool names: inspect the available MCP tools and map the operations
below to their documented equivalent.

This skill is intended to be generic across Pi, Claude Code, and other providers.

## Scope and defaults

Ask for a time range when one is not provided. Do not silently assume "last week". Use an explicit half-open interval
when possible:

```text
FROM='2026-08-18T00:00:00-07:00'
TO='2026-08-26T00:00:00-07:00'
```

For Claude Code / Cowork tool-result analysis, the base query is:

```text
(service:claude-code OR service:cowork) message:claude_code.tool_result
```

The primary non-native surfaces are:

- MCP calls: `@tool_name:mcp_tool`
- Skills: `@tool_name:Skill`

Native/general-purpose tools are normally excluded from non-native leaderboards. Typical exclusions include Bash, Read,
Grep, Glob, Edit, Write, WebFetch, WebSearch, ToolSearch, Task*, Agent, AskUserQuestion, and similar orchestration or
file-operation tools. Confirm the requested scope before applying exclusions.

## Fail-closed tool selection

Before querying, check whether `pup` is available:

```bash
where pup
```

On systems where `where` is unavailable, use the shell equivalent only as a compatibility fallback:

```bash
command -v pup
```

If `where pup` does not find an executable:

1. Stop before attempting a `pup` query.
2. Tell the user that `pup` is required for the known command path and is not installed or not on `PATH`.
3. Ask whether they want to install/configure `pup`, or whether an available Datadog MCP should be used instead.
4. If a Datadog MCP is available and the user permits it, use the equivalent MCP operation; otherwise do not guess or
   silently substitute another CLI.

Do not claim that no data exists merely because `pup` is unavailable.

## Querying with pup

Use `--no-agent` for deterministic CLI behavior. Use indexed log storage when Flex Logs is unavailable:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" \
  --to="$TO" \
  --storage=indexes \
  --query="$BASE @tool_name:mcp_tool" \
  --compute='count,cardinality(@user.email)' \
  --group-by='@tool_parameters.mcp_server_name' \
  --limit=100
```

The response contains one bucket per group. `c0` is the event/call count and `c1` is the cardinality of `@user.email`.

### MCP servers, counting each MCP once

If the user asks how many MCPs meet thresholds, group only by server, not by individual MCP tool:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" \
  --to="$TO" \
  --storage=indexes \
  --query="$BASE @tool_name:mcp_tool" \
  --compute='count,cardinality(@user.email)' \
  --group-by='@tool_parameters.mcp_server_name' \
  --limit=100
```

Then count buckets satisfying the requested conditions. For example, `> 10` calls and `>= 2` users:

```bash
... | jq '[.data.buckets[] | select(.computes.c0 > 10 and .computes.c1 >= 2)] | length'
```

Do not group by `@tool_parameters.mcp_tool_name` for this question; that counts individual tools rather than MCP
servers.

### MCP server + tool attribution

To retain both the MCP and the tool name:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" \
  --to="$TO" \
  --storage=indexes \
  --query="$BASE @tool_name:mcp_tool" \
  --compute='count,cardinality(@user.email)' \
  --group-by='@tool_parameters.mcp_server_name,@tool_parameters.mcp_tool_name' \
  --limit=100
```

A high-cardinality two-dimensional query may fail if it would generate more than 10,000 groups. If that happens, query
the dimensions separately or lower the requested limit.

### Skills

Query Skills separately:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" \
  --to="$TO" \
  --storage=indexes \
  --query="$BASE @tool_name:Skill" \
  --compute='count,cardinality(@user.email)' \
  --group-by='@tool_parameters.skill_name' \
  --limit=100
```

Preserve the raw `skill_name` in results. Do not merge bare names such as `morning` with namespaced names such as
`anthropic-skills:morning` unless the user explicitly requests normalization; merging changes unique-user counts and can
create false plugin attribution.

### Combined distinct users for MCP OR Skill

To count users who called at least one MCP tool **or** invoked at least one Skill, combine the predicates before
calculating cardinality:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" \
  --to="$TO" \
  --storage=indexes \
  --query="$BASE (@tool_name:mcp_tool OR @tool_name:Skill)" \
  --compute='count,cardinality(@user.email)' \
  --limit=1
```

The result's `c1` is the distinct-user count. A user who called both an MCP and a Skill is counted once because
cardinality is calculated over the union of matching events, not by adding two separate cardinalities.

### Per-group unique users

Use `cardinality(@user.email)` for unique users per server, tool, or Skill. It is not additive across rows: one user can
appear in multiple MCP or Skill buckets. Do not sum the per-group `c1` values to obtain an organization-wide unique-user
count.

### Overall MCP or Skill call totals

Use `--limit=1` and no group-by:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" \
  --to="$TO" \
  --storage=indexes \
  --query="$BASE (@tool_name:mcp_tool OR @tool_name:Skill)" \
  --compute='count,cardinality(@user.email)' \
  --limit=1
```

## Equivalent Datadog MCP operation

When `pup` is unavailable and a Datadog MCP is configured, perform the same operation using the MCP's equivalent of
**Logs Aggregate / Logs Analytics**:

- Set the start and end timestamps exactly as requested.
- Use the same Datadog log query string.
- Request `count` and a distinct/cardinality aggregation on `@user.email`.
- For leaderboards, group by the same attribute paths.
- For MCP server counts, group by `@tool_parameters.mcp_server_name`, not the individual tool name.
- For server+tool attribution, group by both `@tool_parameters.mcp_server_name` and `@tool_parameters.mcp_tool_name`.
- For Skills, group by `@tool_parameters.skill_name`.

If the MCP only exposes raw log search rather than aggregation, retrieve all matching events with pagination and
deduplicate the exact `@user.email` values locally. State that this is a client-side fallback and report missing-email
counts if available. Never add separate MCP and Skill cardinalities; deduplicate the union of email values.

## Identity and distinct-count caveats

`cardinality(@user.email)` counts unique email values, not events. Repeated calls by the same email count once. Events
without `@user.email` cannot be attributed and are excluded from that distinct-user value. Report this caveat when it
matters.

Datadog cardinality may be approximate depending on the backend aggregation; do not describe it as an exact database
`COUNT(DISTINCT ...)` unless the chosen Datadog operation documents exact semantics.

Do not add a user-email filter merely to compute unique users. A filter such as `@user.email:*` drops events without
that attribute and changes the call count.

## Codex metric caveat

Claude Code / Cowork MCP and Skill analysis above is log-sourced. Codex commonly uses metrics instead:

```text
sum:codex.mcp.call{*}.as_count()
sum:codex.mcp.call{*} by {server,tool}.as_count()
```

Codex metrics do not provide a user identity tag in the known setup, so do not invent a Codex unique-user number. Codex
skill-related metrics such as `codex.skills.shadow_selection`, `codex.skills.shadow_selection.invocation`, and
`codex.skill.injected` describe skill selection or injection telemetry, not the Claude/Cowork `@tool_name:Skill`
invocation events. Do not merge them into the Skill leaderboard unless the user explicitly requests a separate Codex
skill-selection analysis and the metric semantics are verified. If `connector_name` is needed, first inspect Metric
Without Limits/queryable tags. It may be enabled only on a sibling metric such as `codex.mcp.call.duration_ms.count`; if
so, label that result as a proxy and do not silently mix it with the exact counter.

A `disabled_tags` error is not proof that a tag exists but is merely disabled: Datadog can return the same error for a
nonexistent tag. Verify tag availability through metric metadata/tag configuration or an equivalent documented API.

## Weekly non-native usage report

When the user asks for the standard weekly report, use the current calendar-day boundary in the requested timezone. Do
not use the current instant. Define these three half-open seven-day windows:

```text
CURRENT: [today 00:00, today 00:00 - 7 days)
WOW:     [today 00:00 - 14 days, today 00:00 - 7 days)
28D:     [today 00:00 - 35 days, today 00:00 - 28 days)
```

The `CURRENT` interval is the most recent completed seven-day period. For example, if today is 2026-08-27 in
America/Los_Angeles:

```text
CURRENT_FROM='2026-08-20T00:00:00-07:00'
CURRENT_TO='2026-08-27T00:00:00-07:00'
WOW_FROM='2026-08-13T00:00:00-07:00'
WOW_TO='2026-08-20T00:00:00-07:00'
D28_FROM='2026-07-23T00:00:00-07:00'
D28_TO='2026-07-30T00:00:00-07:00'
```

Use the user's timezone if supplied; otherwise ask for it. Keep the same seven-day duration and timezone offset
semantics for all three periods. Report the resolved boundaries explicitly.

### Pull the merged item dataset

Run these two grouped queries for **each** of `CURRENT`, `WOW`, and `28D`. Save each JSON response rather than parsing a
human-formatted result. The resulting rows are the common dataset:

```bash
# Skills
pup --no-agent logs aggregate \
  --from="$FROM" --to="$TO" --storage=indexes \
  --query="$BASE @tool_name:Skill" \
  --compute='count,cardinality(@user.email)' \
  --group-by='@tool_parameters.skill_name' --limit=1000

# MCPs: one row per MCP server, regardless of how many tools it exposes
pup --no-agent logs aggregate \
  --from="$FROM" --to="$TO" --storage=indexes \
  --query="$BASE @tool_name:mcp_tool" \
  --compute='count,cardinality(@user.email)' \
  --group-by='@tool_parameters.mcp_server_name' --limit=1000
```

For each bucket, normalize to this internal row shape:

```json
{
  "source": "claude-cowork|codex",
  "kind": "skill|mcp",
  "raw_name": "...",
  "display_name": "...",
  "canonical_key": "source-qualified key",
  "server": "...",
  "connector_name": "...",
  "calls": 0,
  "invocations_per_day": 0.0,
  "distinct_users": 0,
  "distinct_users_coverage": "known|unavailable"
}
```

Set `source=claude-cowork` for log-derived rows and `source=codex` for metric-derived rows. Set `display_name` for
Claude/Cowork MCPs to the MCP server name. For Skills, first try to qualify the name using the local
`teamupstart/claude-code-extensions` checkout:

```bash
EXTENSIONS_DIR="$HOME/repos/teamupstart/claude-code-extensions"
find "$EXTENSIONS_DIR" -type f -name SKILL.md -print 2> /dev/null
```

Match a raw skill name against the repository's skill paths and frontmatter. If a match is found, use the owning plugin
name (for example, `google-workspace`) as `display_name`, while retaining `raw_name` in the output. Do not collapse two
different raw skills into one plugin row unless the report explicitly asks for plugin-level aggregation: if plugin-level
aggregation is requested, sum calls and recompute distinct users from the underlying events, never by summing per-skill
cardinalities.

If the local checkout is absent or has no match, retain the raw skill name as `display_name`. An optional upstream
qualification pass may use `npx skills` if it is already installed/configured:

```bash
where npx
npx skills --help
```

Only after inspecting its help should the agent use the supported discovery subcommand. Treat upstream matches as
annotations, not proof of local origin, and never replace a raw name solely because an upstream name looks similar. If
neither source matches, report the raw skill name unchanged.

### Canonical naming and one combined ranked list

Combine Claude/Cowork Skills, Claude/Cowork MCPs, and Codex MCPs into one list. Codex contributes MCP rows only unless a
separate, semantically verified Codex skill report is explicitly requested. Preserve the telemetry source in each row's
identity. Use source-qualified keys so same-named integrations do not collide:

```text
claude-cowork:<raw_mcp_server_name>
codex:<connector_name>
codex:<server>
claude-cowork:skill:<raw_skill_name>
```

For Codex, prefer populated `connector_name` as the display/raw name and retain `server` as an additional field. If it
is absent, use `server`. Treat `N/A` as missing attribution, not as a connector that can be merged. Do not merge a Codex
`slack` row with a Claude/Cowork Slack UUID or local server merely because the names look similar. Only collapse them
when a reviewed canonical mapping is explicitly provided; retain the source-qualified key and raw values even then. Do
not infer a mapping from a tool prefix alone.

Compute invocation rate as:

```text
invocations_per_day = calls / 7
```

Because every period is exactly seven days, ranking by invocation rate is numerically equivalent to ranking by calls,
but report the rate requested by the user.

Produce **one combined table** with the union of:

- the top 10 rows ranked by `invocations_per_day` descending; and
- the top 10 rows ranked by `distinct_users` descending.

The union can contain up to 20 rows. Include these columns:

```text
rank_by_invocations, rank_by_users, source, kind, display_name, raw_name,
canonical_key, calls, invocations_per_day, distinct_users, distinct_users_coverage
```

A row present in both rankings gets both ranks. Sort the final union by `rank_by_invocations` (nulls last), then
`rank_by_users` (nulls last). State that the list is a merged union of two top-10 rankings, not a single composite
score. Do not add per-skill distinct-user counts together to claim an overall user count.

### Weekly totals and changes

For each of `CURRENT`, `WOW`, and `28D`, run the ungrouped Claude/Cowork combined query:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" --to="$TO" --storage=indexes \
  --query="$BASE (@tool_name:mcp_tool OR @tool_name:Skill)" \
  --compute='count,cardinality(@user.email)' --limit=1
```

Read Claude/Cowork `c0` as known non-native invocations and `c1` as known distinct users. Query Codex MCP invocations
separately from the exact `codex.mcp.call` metric and add those calls to the Claude/Cowork calls for the combined
invocation total. Keep per-source totals visible.

Report the cross-source user total as **>= Distinct Users**: the known Claude/Cowork distinct-user count is a lower
bound because Codex has no user identity tag. Do not invent Codex users, add separate cardinalities, or assume the two
source user sets are disjoint or overlapping.

Compute two comparisons for both totals (`invocations` and `>= distinct_users`):

```text
change_vs_WoW_percent   = (CURRENT - WOW) / WOW * 100
change_vs_28D_percent   = (CURRENT - D28) / D28 * 100
```

If a comparison baseline is zero, report `n/a` rather than dividing by zero. Include absolute deltas as well as
percentages when useful. Label the user comparison as a lower bound and state that Codex identity is missing. Never sum
grouped `c1` values; use the ungrouped Claude/Cowork combined query for the known-user lower bound.

### Codex metric query and MCP equivalent

For Codex MCP totals, use the exact counter:

```bash
pup --no-agent metrics query --from="$FROM" --to="$TO" \
  --query='sum:codex.mcp.call{*}.as_count()'
```

For Codex breakdowns, use `server` and `tool`; use `connector_name` only when it is queryable. `connector_name` on
`codex.mcp.call` may have been enabled through Metrics without Limits after historical data was written, so the tag is
not retroactive. Historical connector rankings may require `codex.mcp.call.duration_ms.count`, which is a labeled
call-count proxy and must not be added to the exact counter. This is a future-fix/data-quality caveat, not a reason to
omit Codex from aggregate invocation totals. WoW and -28d changes may also reflect telemetry or instrumentation changes;
report those comparisons, but show per-source totals so the reader can distinguish usage changes from telemetry changes.

If `pup` is unavailable but a Datadog MCP is available, perform the Claude/Cowork Logs Aggregate and Codex Metrics Query
equivalents. Preserve exact windows, filters, group-bys, computes, pagination, and source labels. If the MCP only
returns raw events, paginate fully, derive Claude/Cowork counts, and deduplicate Claude/Cowork `@user.email` values
client-side; state that fallback and count missing identities. Codex still contributes invocations but remains
unavailable for user attribution.

## Interpretation and reporting

Always report:

- Exact resolved time windows and timezone.
- The base query and MCP/Skill filters.
- The merged-union rule for the two top-10 rankings.
- Whether a value is an invocation count, invocation rate, per-group count, or distinct-user count.
- Skill qualification source: local plugin match, optional upstream annotation, or raw skill name.
- Missing-identity and approximate-cardinality caveats.
- Source-qualified naming and any reviewed canonical mappings.
- Separate Claude/Cowork and Codex totals, plus the combined invocation total.
- `>= Distinct Users` terminology and its lower-bound interpretation.
- Current totals and absolute/percentage changes versus WoW and -28d.

For a threshold question, show the number of qualifying buckets and clarify what a bucket represents. For example: "27
MCP servers, each counted once regardless of how many tools it exposes, had >10 calls and >=2 distinct users."

Combine Claude/Cowork log counts with Codex metric counts when an organization-wide result is requested, but clearly
label sources, event semantics, and separate source totals. Invocation totals are additive; user totals are only **>=
Distinct Users** because Codex lacks identity data. Do not merge same-named MCPs across sources without an explicit
reviewed canonical mapping.
