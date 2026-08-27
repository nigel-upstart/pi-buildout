# AI Tool Usage skill

`ai-tool-usage` produces weekly AI non-native tool usage reports from Datadog. Requires `gh` and either `pup` CLI
or a Datadog MCP.

## What the report includes

The standard weekly report uses three completed seven-day windows, anchored at 00:00 in the requested timezone:

- **Current:** `[today 00:00 - 7 days, today 00:00)`
- **WoW baseline:** the preceding seven-day interval
- **-28d baseline:** the seven-day interval beginning 28 days before `today 00:00`

It produces, at minimum:

1. One merged list whose rows are the union of the top 10 by invocation rate and a top 10 by distinct users.
2. Skill qualification from `teamupstart/claude-code-extensions` when possible.
3. Per-source totals and combined invocation totals.
4. Week-over-week and -28-day absolute and percentage changes for invocations and the user lower bound.

Separate Claude/Cowork and Codex breakdown by skill and MCP/Connector.

## Data sources and semantics

### Claude Code / Cowork

Claude Code and Cowork usage is read from `claude_code.tool_result` logs:

```text
(service:claude-code OR service:cowork) message:claude_code.tool_result
```

- MCP invocations: `@tool_name:mcp_tool`
- Skill invocations: `@tool_name:Skill`
- MCP identity: `@tool_parameters.mcp_server_name`
- Skill identity: `@tool_parameters.skill_name`
- Known user identity: `@user.email`

`cardinality(@user.email)` counts each email value once across the matched event set. A user who invoked both an MCP and
a Skill is counted once when the query uses the combined predicate before cardinality. Events without `@user.email` are
not attributable to a known user.

### Codex

Codex MCP usage is metric-sourced:

```text
sum:codex.mcp.call{*}.as_count()
```

Codex MCP metrics contribute to invocation totals and rankings, but the known telemetry has no user/email/actor tag.
Therefore the report must use the label **`>= Distinct Users`** for the cross-source user measure. This is the known
Claude/Cowork distinct-user count and is a lower bound.

Codex skill-looking metrics exist, including:

- `codex.skills.shadow_selection`
- `codex.skills.shadow_selection.invocation`
- `codex.skill.injected`

These are not semantically equivalent to Claude/Cowork `@tool_name:Skill` invocation events.

## Combining Codex and Claude/Cowork

Combining invocation totals is valid when:

- all sources use the same half-open time window;
- Codex uses one metric consistently for every comparison period; and
- the report preserves separate source totals.

The combined invocation total is additive:

```text
combined invocations = Claude/Cowork log invocations + Codex MCP metric invocations
```

The combined distinct-user total is not available. Report:

```text
>= Distinct Users = known Claude/Cowork distinct users
```

WoW and -28d changes are still useful, but can reflect instrumentation changes, telemetry rollout, log/metric ingestion
gaps, or retention differences in addition to real usage changes. Showing the Claude/Cowork and Codex components adds 
transparency.

## Source-qualified naming

Claude/Cowork MCP names may be UUIDs or local server names. Codex may expose:

```text
server:codex_apps
connector_name:slack
tool:slack.slack_search_public_and_private
```

The report must not merge a Codex `slack` row with a Claude/Cowork MCP UUID merely because they appear to represent the
same integration. Use source-qualified keys:

```text
claude-cowork:<raw_mcp_server_name>
codex:<connector_name>
codex:<server>
claude-cowork:skill:<raw_skill_name>
```

Codex `connector_name` is preferred when populated, while retaining `server` as a field. If it is absent, `server` is 
used. `N/A` is treated as missing attribution. Rows are collapsed across sources when a reviewed canonical mapping is 
explicitly available. Canonical mappings are not inferred from a tool prefix alone.

## Connector-name history caveat

`connector_name` on `codex.mcp.call` has been enabled after historical points were written. This configuration is not
retroactive. Prior to Aug 27, 2026, historical connector rankings need the sibling metric:

```text
sum:codex.mcp.call.duration_ms.count{*} by {connector_name}.as_count()
```

That is a labeled call-count proxy, not an exact substitute for `codex.mcp.call`. This will age out and can be removed 
after the -28d window is exceeded and the prior data isn't factored into the report. This should not prevent aggregate 
Codex invocation totals from being reported.

## Tool selection and fallback

The skill fails closed if

```bash
where pup
```

return unavaialble and there is no available Datadog MCP equivalent. The MCP path preserves the same time windows, 
filters, group-bys, metrics, pagination, and source labels.

See `SKILL.md` for the exact commands and execution procedure.
