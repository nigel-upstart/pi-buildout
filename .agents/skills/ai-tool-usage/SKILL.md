---
name: ai-tool-usage
description: >-
  Analyze AI tool usage in Datadog, especially Claude Code and Cowork MCP tools and Skills, using the pup CLI or an
  available Datadog MCP equivalent. Use when asked about AI tool calls, MCP adoption, skill usage, unique users, usage
  leaderboards, or non-native tool usage over a specified time range.
argument-hint: "<Datadog AI usage question and time range>"
allowed-tools: Read, Bash(*), Grep, Glob
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

Codex metrics do not provide a user identity tag in the known setup, so do not invent a Codex unique-user number. If
`connector_name` is needed, first inspect Metric Without Limits/queryable tags. It may be enabled only on a sibling
metric such as `codex.mcp.call.duration_ms.count`; if so, label that result as a proxy and do not silently mix it with
the exact counter.

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
  "kind": "skill|mcp",
  "raw_name": "...",
  "display_name": "...",
  "calls": 0,
  "invocations_per_day": 0.0,
  "distinct_users": 0
}
```

Set `display_name` for MCPs to the MCP server name. For Skills, first try to qualify the name using the local
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

### Build one combined ranked list

Combine the normalized Skill and MCP rows from `CURRENT` into one list. Keep `kind` and a stable key
(`kind + ':' + raw_name`) so a skill and MCP with the same display name do not collide. Compute invocation rate as:

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
rank_by_invocations, rank_by_users, kind, display_name, raw_name,
calls, invocations_per_day, distinct_users
```

A row present in both rankings gets both ranks. Sort the final union by `rank_by_invocations` (nulls last), then
`rank_by_users` (nulls last). State that the list is a merged union of two top-10 rankings, not a single composite
score. Do not add per-skill distinct-user counts together to claim an overall user count.

### Weekly totals and changes

For each of `CURRENT`, `WOW`, and `28D`, run the ungrouped combined query:

```bash
pup --no-agent logs aggregate \
  --from="$FROM" --to="$TO" --storage=indexes \
  --query="$BASE (@tool_name:mcp_tool OR @tool_name:Skill)" \
  --compute='count,cardinality(@user.email)' --limit=1
```

Read `c0` as total non-native invocations and `c1` as distinct users. The combined filter is essential: cardinality is
calculated over the union, so a user who invoked both an MCP and a Skill is counted once.

Compute two comparisons for both totals (`invocations` and `distinct_users`):

```text
change_vs_WoW_percent   = (CURRENT - WOW) / WOW * 100
change_vs_28D_percent   = (CURRENT - D28) / D28 * 100
```

If a comparison baseline is zero, report `n/a` rather than dividing by zero. Include absolute deltas as well as
percentages when useful. If cardinality is approximate, label the user comparison accordingly. Never sum the grouped
`c1` values; use the ungrouped combined query for the total distinct-user count.

### MCP equivalent

If `pup` is unavailable but a Datadog MCP is available, perform the same six grouped queries and three ungrouped queries
through its Logs Aggregate / Logs Analytics equivalent. Preserve the exact three time windows, filters, group-by fields,
computes, and pagination. If the MCP only returns raw events, paginate fully, derive call counts, and deduplicate the
union of `@user.email` values client-side; state that fallback and count missing identities.

## Interpretation and reporting

Always report:

- Exact resolved time windows and timezone.
- The base query and MCP/Skill filters.
- The merged-union rule for the two top-10 rankings.
- Whether a value is an invocation count, invocation rate, per-group count, or distinct-user count.
- Skill qualification source: local plugin match, optional upstream annotation, or raw skill name.
- Missing-identity and approximate-cardinality caveats.
- Current totals and absolute/percentage changes versus WoW and -28d.

For a threshold question, show the number of qualifying buckets and clarify what a bucket represents. For example: "27
MCP servers, each counted once regardless of how many tools it exposes, had >10 calls and >=2 distinct users."

Do not combine Claude/Cowork log counts with Codex metric counts without clearly labeling the different sources and
event semantics.
