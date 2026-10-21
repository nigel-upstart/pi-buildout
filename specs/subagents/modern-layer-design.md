# DRAFT — Manager-first review delegation through one shared signaling protocol

> **DRAFT design — P0/P2/P3/P4 implementation authorized by the operator.** Approval authorizes separate implementation
> branches and sequential draft PRs; it does not mean code has landed. Existing coordinator-owned PRs remain untouched.
> P5 canary is separately assigned; other speculative investigations remain issue-only. No merge/ready/install is
> authorized.

| Field        | Value                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Owner(s)     | Nigel Stuke (operator); drafted by a delegated design agent                                             |
| Status       | DRAFT design; P0/P2/P3/P4 implementation authorized                                                     |
| Last updated | 2026-10-21                                                                                              |
| Doc type     | ADR-style design proposal (ADR body plus evidence appendices; the body exceeds the ADR band on purpose) |
| Branch       | `docs/subagent-layer-design`, based on `origin/main` `f6a55d1e2241d4ba514ec8f951210f43e136983d`         |
| Links        | [`extensions/subagents`](../../extensions/subagents), [`extensions/router`](../../extensions/router)    |

WiWi note: the operator did not supply a brain dump (step 3) for this document; it was produced by enrichment from
repository, upstream, and Pi source evidence. Step 7 (operator reads every line) remains outstanding.

**Reader guide:** [durable-example hints (§3.2)](#five-source-grounded-comparisons), including
[hint 4: model routing](#durable-hint-4) and [hint 5: recursion](#durable-hint-5);
[§4: option comparison](#4-options-evaluated-against-the-decided-order);
[§5: shared signaling design](#5-operator-decided-resolution-and-shared-signaling).

## Executive summary

**Operator-decided resolution order, per review:** (1) shared signaling, (2) classifier-found spawn tool through
builder-steered delegation, (3) a separate in-process Pi SDK reviewer. An available manager is preferred; delegation is
not opt-in and the SDK is the last fallback, not the default.

One router adapter uses tintinweb's documented `subagents:rpc:*` protocol (verified version **2**), and a proposed
subagents PR makes our extension answer the same minimal subset. Signaling launches a generic task with the
router-selected model/effort, `isolated: true`, and `inheritContext: false`. Completion stays on the event bus;
synchronous consumption suppresses the manager notification. **The signaling path adds nothing to builder context and
spends no builder turn**; the router subsequently delivers only its own advisory outcome.

If signaling discovery finds no compatible option, or signaling fails for this review, a bounded classifier identifies a
suitable normal spawn tool for builder-steered dispatch. Its SWR state and candidate-specific execution quarantine live
in the extension closure; only verified signaling absence/incompatibility can be negatively cached. Operational
signaling/provider/task failures never permanently disable signaling. Refresh preserves the last published match/none
and retries only on access after failure. SDK accepts private `ModelRegistry.runtime` access with a runtime guard;
scheduled canaries test minimum 1.2.0 and latest **released** Pi, checking the supported `>=1.2.0 <2.0.0` range. A
future 2.x release flags an unsupported-upgrade investigation; normal CI covers the pinned version.

There is **no nicobailon signaling or structured-delegation adapter, now or deferred**. Nicobailon remains conceptual
inspiration and a possible builder-steered target through its normal tool. There is no manager election or precedence:
first ping reply wins; multi-manager installations are not a target.

**Finalized:** no router result rewriting; our wait returns final status/answer only; discovery is stale-while-refresh
with a 60-second deadline; reviews use one delta-scaled 5-minute–4-hour budget. Child-task routing now runs in the
parent before spawn, passing an explicit model/effort pair into a no-router child. A bounded parent lifecycle guard
prevents advice-triggered rereview; no child marker/lineage subsystem is required. The router/subagents supported host
range `>=1.2.0 <2.0.0` is approved, with floor release tests required. Only budget tuning remains an operator choice.

## 1. Context and problem statement

The advisory router (stack items A, B, C1, C2) runs plan and completion reviews as prompt guidance. It never blocks
tools. C2 introduces a separate in-process SDK reviewer with read-only built-in tools and a verdict tool. C2 also
reserves a small `ReviewRunner` seam for optional delegation; that delegation is on hold pending this design. The
earlier C3 "generic protocol adapter" and the `pi-review-runner:*` event protocol were withdrawn because no upstream
manager speaks that protocol.

This document decides:

- whether and how a review can be delegated to an installed subagent manager instead of C2's session;
- what the minimal generic contract is;
- which Pi APIs make that possible on Pi 1.2.0 and newer.

## 2. Authoritative constraints

- **Advisory only.** No tool-call blocking, capability-inference gates, or narrowing of the builder's tools.
- **No hard dependency.** The router must work with no subagents extension installed and must not import one. The
  release packaging stages router and subagents separately (`scripts/release-packages.mjs`,
  `scripts/stage-release-package.mjs`).
- **Generic manager, generic messaging.** The manager receives "spawn an agent with this task". The review is only the
  task text the router supplies. The manager has no review kind, verdict schema semantics, or review-runner protocol.
  Task, model, effort, and context options stay generic. Any structured-output option must also be generic. The router
  alone owns the reviewer prompt, schema validation, the advisory lifecycle, stale-result handling, UI, and delivery.
- **Minimalism (operator constraint).** Running several subagent managers at once is not a target use case. The design
  contains no provider arbitration, competing-provider election, precedence or deprioritization of this repository's
  extension, and no "stay silent when tintinweb is present" logic. If several managers answer, the first reply is used.
  No machinery is added proactively; the shared spawn channel is broadcast, so this is not a promise of safe
  simultaneous multi-manager operation. Every new abstraction needs a concrete consumer.
- **Model-informed structured calls are allowed.** Bounded discovery may propose a candidate tool and a declarative
  parameter mapping/call plan grounded in its published schema. Validate tool existence, argument structure/required
  fields, and documented isolation; bind the parent's concrete task/model/effort/isolation, then attempt supported Pi
  invocation. No generated executable adapter code, eval, invented protocol, or bypass of Pi dispatch is approved.
- **No isolation claims.** Fresh conversation context does not isolate the filesystem, credentials, resources, or
  processes. Pi has no built-in permission boundary ([security.md][pi-security]).
- **Builder-visible task prompt is acceptable.** Prefer final-only return paths; third-party tool-result wrappers are
  retained unchanged, so arbitrary manager paths cannot promise zero extra context. Router parsing is observational.

## 3. Findings

### 3.1 Pi native boundaries (verified at v1.2.0, v1.3.0, and main)

`packages/coding-agent/src/core/extensions/types.ts` has **no diff** between v1.2.0 (`06a4669`), v1.3.0 (`71023ae`), and
main (`16f5f0a`). `sdk.ts`, `model-registry.ts`, and `event-bus.ts` are also unchanged across those revisions. Every
primitive below is therefore usable on Pi 1.2.0.

| Primitive                                                 | Evidence (v1.2.0 unless noted)                                                                                                                                                                                              | Consequence                                                                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.executeTool()` exists only on `ExtensionToolContext` | [`types.ts:325-395`][t-ctx]: `ExtensionContext` (event handlers) lacks it; `ExtensionToolContext` (tool `execute()`) adds it                                                                                                | **Confirms the parent's claim.** An event handler cannot invoke another extension's tool. Only a model call, or a router-owned tool that a model calls, can.                                |
| `pi.getAllTools(): ToolInfo[]`                            | [`types.ts:1769`, `2122-2130`][t-toolinfo]; [`agent-session.ts:1498-1510`][as-getall] returns `name`, `description`, `parameters`, `promptGuidelines`, `exposure`, `namespace`, `annotations`, `reachesTools`, `sourceInfo` | Enough for a classifier prompt and a tool-set fingerprint. `reachesTools` was added in 1.2.0 (CHANGELOG).                                                                                   |
| `tool_result` event                                       | [`types.ts:1267-1283`][t-toolresult]: `toolCallId`, `parentToolCallId?`, `toolName`, `input`, `content`, `structuredContent?`, `isError`, `details`, `usage?`; result type allows replacing `content`                       | The router observes result text for validation only; it never rewrites review tool results. Pi also supports transforms, but this design does not use them.                                 |
| Model sees `content`, not `details`                       | [extensions.md][pi-ext] "Tools": result needs model-facing `content` and `details` for rendering                                                                                                                            | Manager UI detail can stay in `details`; only `content` matters for parent-context accounting.                                                                                              |
| `pi.sendMessage(custom, { triggerTurn, deliverAs })`      | [`types.ts:1731-1735`][t-send]; [`agent-session.ts:2318-2350`][as-send]; custom messages reach the model as `user` role ([`messages.ts:162-168`][msgs])                                                                     | The dispatch path. Since 1.2.0 an idle `triggerTurn` run fires `before_agent_start` with `messageType: "custom"` (CHANGELOG 1.2.0 breaking change), so A/B must not reclassify it.          |
| `pi.events` bus                                           | [`event-bus.ts`][evbus]: synchronous `EventEmitter` emit; `on()` returns an unsubscribe. [`loader.ts:193-200`][loader] unsubscribes an extension's bus listeners on reload or session replacement                           | Adapters must treat reload as cancellation of in-flight requests. Each SDK `DefaultResourceLoader` creates its own bus ([`resource-loader.ts:379`][rl]).                                    |
| `createAgentSession` overrides                            | [`sdk.ts:49-105`][sdk-opts]: `modelRuntime`, `model`, `thinkingLevel`, `tools`, `noTools`, `excludeTools`, `customTools`, `resourceLoader`, `sessionManager`, `settingsManager`                                             | C2's fallback. SDK sessions do not load CLI built-in codemode, tool search, or MCP ([sdk.md][pi-sdk]).                                                                                      |
| `ModelRegistry.runtime` is **private**                    | [`model-registry.ts:48-52`][mreg]                                                                                                                                                                                           | **Risk.** Sharing the parent's providers and runtime-only keys with an SDK session needs `Reflect.get(ctx.modelRegistry, "runtime")`. Ours (`index.ts:102-108`) and tintinweb both do this. |
| `ctx.modelRegistry.streamSimple()` is public              | [`model-registry.ts:138`][mreg]; [extensions.md][pi-ext] recommends it for nested model calls                                                                                                                               | A fully public, if larger, fallback: pi-agent-core `Agent` (a bundled virtual module) with `streamFn` backed by `streamSimple`.                                                             |
| Extension import surface                                  | [`virtual-modules.ts:1-30`][vmods]: pi-agent-core, pi-ai/compat, pi-tui, pi-coding-agent, typebox                                                                                                                           | `@earendil-works/pi-durable` is **not** importable by a CLI extension without bundling it separately.                                                                                       |
| `RpcClient` export                                        | [`rpc-client.ts`][rpcclient] spawns the literal `node <cliPath>`, SIGTERM then SIGKILL, and has no process-tree or UI-request handling                                                                                      | Not a drop-in replacement on reviewed evidence (launch variants, tree kill, dialogs); independent RPC simplification investigation pending.                                                 |

**Post-1.3 or unreleased on main:** coding-agent `docs/extensions.md` gained lifecycle diagrams and a handler
composition table (docs only). `src/` changes touch compaction, model config, codemode `execute.ts`, and shell
resolution; the extension API does not change. pi-durable's `[Unreleased]` section adds durable sleeps, an IndexedDB
store, telemetry, and a SQLite schema v2 that 1.3.0 cannot open. Nothing in this design depends on any of it.

### 3.2 Durable-based coding-agent examples: transferable reference, not adoption

**Purpose correction:** the user requested the actual coding-agent example **built on durable** as a forward-looking
design reference, never adoption of pi-durable. This comparison uses release SHA
`71023aec1546d6d677a65669c5665c0927ce0dd0` throughout. It is evidence about these examples, **not** a maintainer roadmap
or a claim that the Pi CLI will acquire their APIs. No such maintainer commitment was established. The [durable
README][durable-readme] describes an experimental separate harness; its persistence/ownership guarantees are
distinguished from ordinary design patterns below, not treated as a reason to dismiss the example.

[`26-coding-agent.ts`][dx26] is the actual small coding agent: it installs `CodingTools`, builds preamble/cwd sections,
reads host settings through getters, and supplies a cwd-specific execution environment (lines 28–63). It does **not**
itself install subagents. Sibling examples [22][dx22] and [23][dx23] implement foreground/background children;
[28][dx28] constructs a separate reviewer with explicit model/extensions/tools/cwd. Its example directory is a temporary
checkout-shaped fixture, not an executed `git worktree add` (28:48–50).

#### Five source-grounded comparisons

1. **Ownership is a lifetime policy, not merely a child id.** Foreground 22:46–68 binds the child to the launching tool
   task. Background 23:56–76 and 182–201 instead inserts a background anchor so ordinary parent abort/idle waits do not
   reach that child. The associated [`ConversationHandle`/abort types][durable-handles] define scoped abort and idle
   semantics. **Current equivalent:** our direct-child map, session-shutdown cleanup, `ManagedSubagent.stop()`
   (rpc.ts:414–426), SDK abort/dispose, and P2/P3 signal/stop. Our `waitForIdle` abort cancels only the wait and
   explicitly leaves the child running (rpc.ts:381–411). **Missing seam:** no Pi CLI task-owned conversation tree or
   universal terminal-ownership proof. **Minimal implication:** existing P2/P3/P6 tests must distinguish cancelled wait,
   settled child, and stopped process; preserve the no-overlapping-review rule. Do not silently make ordinary wait
   cancellation kill background work. **Not adopted:** durable anchors, bottom-up task-graph abort, persisted ownership,
   or restart recovery. Those are durable-runtime guarantees ([ownership reference][durable-abort]), not supplied by our
   ids/signals.

2. **Start/await/result identity is more precise than “the agent is idle.”** 22:65–73 submits, awaits the returned
   submission, checks its terminal status/type, then fetches the exact `answer` entry. [`Submission`][durable-handles]
   has id/status/wait/abort; the [settled record][durable-settlement] distinguishes done-with-answer from unanswered.
   23:90–116 records delivered answer ids before reporting and reuses request ids across restart. **Current
   equivalent:** create returns child id, `start()` acknowledges RPC prompt acceptance (rpc.ts:301–305), later
   wait/terminal events return the final answer; P1 uses bounded `lastAssistantText`. **Missing seam:**
   `lastAssistantText` is session-latest, not a public per-submission result handle, and tintinweb request ids correlate
   rather than deduplicate spawn. **Minimal implication:** in P2/P3 bind one fresh child id and one terminal delivery to
   each router attempt; in P6 test duplicate/late events and never resend uncertain spawn. No new handle framework is
   warranted for one-task reviews. **Structured-final-result distinction:** these examples return prose, not
   schema-validated reviewer JSON. The associated [tool result types][durable-output] separately define model `output`,
   schema-validated `structuredOutput`, UI `details`, and usage. Current Pi's content/structuredContent/details and C2's
   verdict tool already supply analogous channels. Keep generic manager final text and router-owned nonce/schema
   validation; P1 removes transcript at its source and P4 only observes third-party output. No new structured-output
   manager protocol, persisted answer ledger, or exactly-once claim is adopted.

3. **Explicit agent configuration and explicit conversation context are different.** 22:56–59/67 and 23:190–195 create a
   child with copied agent configuration and submit task input; they do not fork the parent transcript. 26:52–77
   resolves cwd through the environment, while 28:79–87 selects the reviewer's exact extensions and read tool.
   [`AgentState`/creation types][durable-agent] separate model, tools, instructions, cwd, and creation initialization.
   `CodingTools` itself is explicitly [read/write/edit/bash][durable-coding-tools], not an implicit whole CLI
   environment. **Current equivalent:** D's task-only kickoff, SDK SessionManager/resourceLoader/custom entries,
   explicit reviewer tool selection, and P2's independent `inheritContext:false`/`isolated:true`. **Missing seam:**
   managers do not share an identical resource-selection interface; fresh input alone does not exclude ambient router
   resources. **Minimal implication:** retain D/P1 independence and P2/P5 tests for parent-transcript absence, resource
   selection, cwd, and the explicit model/effort pair before first prompt. Use current SDK seams, not a
   conversation-configuration subsystem. **Not adopted:** the durable environment/registry/settings runtime, live
   configuration machinery, automatic worktrees, or filesystem-isolation claims.

4. <a id="durable-hint-4"></a>**Model choice belongs to the application, not child lifecycle management.** 26:56–63
   installs the provider/catalog and selects the root model. 28:52–85 explicitly selects “big”/“small”;
   [`AgentChange`][durable-agent] also exposes thinking level. These are explicit selection examples, not a task
   classifier or future routing roadmap. **Current equivalent:** classify the actual child task in the parent using
   normal routing policy, resolve model and effort together with existing override precedence, then pass both at spawn.
   **Missing seam:** the examples do not solve our private runtime/auth reuse or differing manager model resolution.
   **Minimal implication:** P2/P3/P5/P6 test the explicit pair and unchanged parent model/profile/cache; no child router
   or extra manager inference. **Not adopted:** the sample's cheaper-reviewer policy or a second model router/catalog.

5. <a id="durable-hint-5"></a>**Isolation plus a bounded parent scheduler is simpler than child lineage.** 22:58–59 and
   23:192–195 remove the subagent extension from children. In contrast, 28:31–43 continues until prose includes “No
   further findings.” **Current equivalent:** our automatic review children load no router; task routing finishes before
   creation, and parent stage/attempt guards stop advice-triggered rereview. **Missing seam:** the examples' prose
   sentinel does not bound our parent review/repair lifecycle. **Minimal implication:** retain supported isolation,
   cancellation-before-spawn and no-rereview tests in existing PRs. **Not adopted:** unbounded prose continuation,
   builder tool enforcement, reviewer markers, role/depth propagation, or a new startup metadata API. No child lineage
   system is needed when router exclusion is guaranteed.

**PR impact:** strengthen the already proposed P1/P2/P3/P4/P5/P6 acceptance tests above; add no PR, dependency, runtime,
ownership graph, or protocol. Durable persistence/replay/idempotent submission and transactional report deduplication
stay explicitly out of scope. The reusable hints are separation of lifetimes, accepted-versus-completed handles,
configuration-versus-history, final-result channels, and application-owned routing/recursion policy.

### 3.3 This repository's `extensions/subagents` (main `f6a55d1`)

Subprocess RPC manager: `index.ts` 707 lines, `rpc.ts` 826, `helpers.ts` 248, and `auth-bridge.ts` 52, plus about 890
lines of tests and fixtures.

| Area                                                                              | Still necessary on Pi ≥ 1.2?                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process-tree kill, Windows `taskkill`, `ps` sampling (`rpc.ts:14-100`, `740-800`) | Current subprocess behavior needs cleanup coverage; reviewed `RpcClient` lacks equivalent tree-kill handling. Independent simplification investigation pending; no blanket retention decision.                                                |
| Bounded JSONL framing and pending-request correlation (`rpc.ts`)                  | Duplicates some host RPC framing/correlation. Reviewed client has launch/dialog gaps; whether composition can remove local code is assigned to an independent investigation.                                                                  |
| `auth-bridge.ts` (runtime-only `--api-key` forwarding through env)                | Yes, for subprocesses only. An in-process design would not need it.                                                                                                                                                                           |
| `modelRuntimeFromContext` (`index.ts:102-108`, "Pi 1.1.0 compatibility")          | **Not legacy.** `ModelRegistry.runtime` is still private on main. The comment is misleading and should cite the missing public accessor.                                                                                                      |
| `resolvePiInvocation` → `getPiInvocation` (proposed naming-only rename)           | Current launch helper handles Bun `$bunfs` probing. Operator chose `getPiInvocation`; review coordinator owns a separate tiny commit atop #136, no behavior change. Pi's example uses that name too.                                          |
| `clampThinkingLevel` / `supportedThinkingLevels` (`helpers.ts:138-175`)           | Partly host-duplicated; reviewed SDK clamps effort and the current virtual import surface differs from pi-ai's canonical exports. Independent investigation will assess supported reuse and provider exceptions; no keep/remove decision yet. |
| Task-targeted compaction and classifier (`index.ts:159-357`)                      | Product features. D adds `contextMode: "none"` to skip parent reads and compaction; supplying both model and effort also skips classification.                                                                                                |
| `status` / `wait` output (`formatSnapshot`, `index.ts:432-460`)                   | **Context leak for review delegation.** `wait` returns the task plus up to 45,000 characters of transcript tail (assistant deltas and tool names with 500-character argument previews; `rpc.ts:681-700`).                                     |

The helper rename is documentation-only here; its separate coordinator commit is not implemented or claimed landed.
Independent RPC and thinking-level-duplication investigations may produce factual GitHub follow-up issues; their agents
own that work. This draft neither expands those investigations nor files issues. Current evidence above is a baseline,
not a blanket instruction to retain all local lifecycle or clamp code.

At this draft's base, `packages/pi-router-otel/package.json` and `packages/pi-subagents/package.json` both declare
`@earendil-works/pi-coding-agent: "*"`. The coordinator owns their metadata/test change to the supported range
`>=1.2.0 <2.0.0` on the appropriate review-owned branch; this design branch does not edit manifests. The existing router
installer rejects releases older than 1.2.0 (`scripts/install-pi-version.test.mjs:81`). This range is a support
statement, not a claim that npm enforces runtime compatibility, and does not propose an installer upper-version gate.

### 3.4 `tintinweb/pi-subagents` (`ca93a5247e72e7053fcd10bea7125d6c4205f949`, 0.22.0, MIT)

- Children run in-process through `createAgentSession`. The parent's runtime comes from the private
  `ctx.modelRegistry.runtime` ([`agent-runner.ts:1142-1159`][tw-runner]).
- The `Agent` tool ([`index.ts:1761-1814`][tw-agent]) requires `prompt`, `description`, and `subagent_type` (built-in
  generic type `general-purpose`). It accepts `model`, `thinking`, `run_in_background` (default **true**), `isolated`
  (strips extension, MCP, and skill tools), and `inherit_context` (default **false** = fresh). With `isolated: false`, a
  child loads ambient extensions, which can include this router.
- Background completion is a custom message sent `deliverAs: "steer", triggerTurn: true` that carries only a
  **500-character preview** plus a transcript file path ([`index.ts:466-492`][tw-notify]).
  `get_subagent_result(verbose: true)` appends the child's **full conversation** ([`index.ts:2979-3045`][tw-get]).
- Event bus ([`docs/rpc.md`][tw-rpc]): `subagents:rpc:ping` (protocol 2), `spawn`, `stop`, `consume`, `steer`;
  `subagents:ready` at `session_start`; and lifecycle `subagents:completed`/`failed` carrying `result` and `usage`.
  Spawn options are not validated: unknown keys are dropped silently, and a missing `requestId` replies on a shared
  channel. `structuredOutput` takes a compiled schema object documented as "set only by the workflow host", so it is not
  a stable generic option. A `consume` must be sent, or the completion notification still reaches the parent model.

### 3.5 Nicobailon: conceptual source and normal-tool target only

Reviewed `d48d580954086a426d31f1c7b8d793a1d26ad184` (0.79.2, MIT). The normal `subagent` tool accepts `agent`, `task`,
and a `model` string with an effort suffix ([`schemas.ts:268`][nb-schema]). Explicit `context:"fresh"` wins over global
and agent preferences ([`fork-context.ts:83-87`][nb-fork]); `async` defaults true ([`config.ts:250-251`][nb-async]). The
generic agent is `delegate` ([definition][nb-delegate]). Use `async:false` for a final inline result; avoid `status`
with `view:"transcript"`, which can return 500 transcript lines ([`tool-reference.md:95-96`][nb-tr]).

Research found both an async management bus and a structured delegation API ([source documentation][nb-deleg-doc]). The
latter demonstrates attempt ownership, cancellation, and usage patterns, and contradicts the earlier assumption that
model/effort are agent-definition-only. **Neither event interface is supported or planned.** Only the normal tool can
participate through classifier-found builder-steered dispatch, with no nicobailon-specific router code.

### 3.6 `elpapi42/pi-minimal-subagent` (`4c847a37b7d675470a8c5eb50d736d11ceac910a`, 0.1.0)

`package.json` declares MIT; the repository has no LICENSE file, and GitHub reports no license. It targets the
pre-rename `@mariozechner/*` packages (legacy). It has one blocking `subagent` tool, no event bus, and named agent
files. It confirms the minimal-surface lesson only; nothing new is adopted.

## 4. Options evaluated against the decided order

| Mechanism                                     | Role                                                      | Builder context / turn                                         | Cost and limits                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared tintinweb-compatible signaling         | First choice; one adapter for tintinweb and ours after P2 | Nothing from dispatch or completion; zero builder turns        | Direct model/effort and signal; synchronous consume suppresses notifications. Requires the documented compatible baseline.                    |
| Classifier-found normal tool, builder-steered | Second choice                                             | Task prompt, tool orchestration, final output; builder turn(s) | No provider adapter; model cooperation is advisory. No direct cancellation of its child.                                                      |
| In-process SDK reviewer (stack C2)            | Last fallback                                             | No working context; zero builder turns                         | Read-only built-ins, no ambient router; private runtime access is accepted with canary and guard.                                             |
| Nicobailon signaling / structured delegation  | **Not supported or planned**                              | Not applicable                                                 | Its normal tool remains a builder-steered target, and its design remains conceptual attribution.                                              |
| E. Subprocess RPC reviewer inside router      | Rejected                                                  | No working context                                             | Duplicates about 800 lines or imports a separately packaged sibling. Keep subprocess lifecycle in the manager.                                |
| F. Router-owned `executeTool` wrapper         | Rejected                                                  | Requires builder invocation anyway                             | Adds an unnecessary dispatch layer; schema-grounded call plans are allowed through existing model/tool dispatch, not a new wrapper framework. |

The shared adapter avoids separate provider integrations: one verified subset, plus a thin compatibility surface on our
existing manager. No builder tools are narrowed by this choice.

## 5. Operator-decided resolution and shared signaling

For each eligible root review, attempt signaling, then an eligible published classifier-found builder tool, then SDK.
Skip signaling only for a valid negative discovery cache, and skip quarantined candidate contracts. Fall forward only
for unavailability/prelaunch failure or confirmed terminal failure with budget left; uncertain ownership never
authorizes overlapping launches. Resolve the child-specific model/effort pair in the parent before any creation; do not
cycle or retry spawn. Epochs, parent stage/attempt scheduling, and verdict validation remain router-owned. E/F in
section 4 remain rejected; the durable-example comparison is not an adoption alternative.

### 5.1 Exact shared subset (tintinweb protocol 2)

The source contract is [`docs/rpc.md`][tw-rpc] and [`src/cross-extension-rpc.ts:27-111`][tw-wire] at `ca93a52`. The same
subset was checked in released 0.22.0 ([release source][tw-release-wire]); package version 0.22.0 and ping protocol
version 2 are distinct. These are existing names/envelopes, not a new review protocol.

| Operation  | Channels                                                            | Request / response used                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probe      | `subagents:rpc:ping` → `subagents:rpc:ping:reply:<requestId>`       | Send `{requestId}`; accept first reply only, `{success:true,data:{version:2}}`. Only version 2 has been verified.                                                                 |
| Spawn      | `subagents:rpc:spawn` → `subagents:rpc:spawn:reply:<requestId>`     | `{requestId,type:"general-purpose",prompt,options}`; success requires `{success:true,data:{id:string}}`. This means accepted/started, not finished.                               |
| Completion | `subagents:completed`, `subagents:failed`                           | Correlate owned `id`; take `result` text and optional `error`, `status`, `usage`. Validate the router's nonce-tagged verdict, not a builder paraphrase.                           |
| Consume    | `subagents:rpc:consume` → `subagents:rpc:consume:reply:<requestId>` | Send `{requestId,agentId}` synchronously in the matching terminal handler, **before any await**, even for stale or invalid results. Success can be just `{success:true}`.         |
| Stop       | `subagents:rpc:stop` → `subagents:rpc:stop:reply:<requestId>`       | Send `{requestId,agentId}` on cancellation, deadline, or shutdown; success can be just `{success:true}`. Treat it as control acknowledgement, not proof of physical process exit. |

**Every request has a fresh unique `requestId`**, including ping, consume, and stop. Subscribe to its reply channel
before emitting, remove that subscription on settlement, and bound all waits. Never use a shared or `:reply:undefined`
channel. Successful replies may omit `data` for void operations. An error envelope is `{success:false,error:string}`;
preserve the diagnostic and distinguish protocol-discovery incompatibility from operational or review-task failure. An
unsupported ping version is evidence of no compatible signaling option; a spawn/provider/task error is not by itself
such evidence. Unexpected payloads fail the current attempt unless they deterministically prove a protocol mismatch; do
not invent an older-version dialect or apply an operational signaling breaker.

**Field-name correction:** `subagent_type` is the `Agent` **tool** parameter, not the signaling field. The logical
generic type maps to top-level `type: "general-purpose"` on `subagents:rpc:spawn`
([`cross-extension-rpc.ts:110-169`][tw-spawn]). Likewise `prompt` is top-level, not in `options`. Sending the tool
spelling on this channel would silently drop it.

The exact launch fields the router sends are:

- top-level `prompt`: the complete task and nonce-tagged output instruction; top-level `type`: generic
  `"general-purpose"`;
- `options.description`: a task label containing the unique attempt token, echoed by terminal events for early
  correlation;
- `options.model`: exact `"provider/modelId"` string; `options.thinkingLevel`: router-selected effort;
- `options.isolated: true`: no ambient extensions/router in the child; `options.inheritContext: false`: no parent
  conversation copied into the child;
- `options.signal`: the attempt's AbortSignal (this is an in-process bus, not serialized RPC).

No other options are required or sent. Scheduling, worktrees, workflows, resume, agent-memory settings, compiled
`structuredOutput`, queue overrides, callback overrides, and caller-forged ownership are outside the subset. Our handler
ignores unsupported extra options rather than advertising their support; it rejects invalid required fields. The generic
type is a compatibility alias to our ordinary task runner, not a named reviewer persona. Our handler need not reproduce
tintinweb's profile system. No `steer`, registry singleton, or readiness subscription is needed.

### 5.2 Probe timing, delivery, and sharp edges

Probe at review start, after `session_start`, unless a valid instance-lifetime negative discovery cache says no
compatible signaling option exists. Do not cache successful ping or operational failure. Bus emission and handlers'
synchronous prefixes are cheap and in-process. **Evidence nuance:** tintinweb wraps even ping in an async handler with
`await fn(params)` ([`cross-extension-rpc.ts:84-108`][tw-wire]), so its reply arrives in a microtask rather than
necessarily before `emit()` returns. Await a bounded reply promise; do not treat an empty synchronous slot as absence.
This needs no long-lived discovery service. First reply wins, with no arbitration or provider-specific priority.

Tintinweb does not bind the remaining requests to the ping responder: spawn broadcasts too. Multiple installed
responders can therefore launch duplicates; first-reply handling cannot prevent that. Such installations remain
explicitly out of scope; no routing/election machinery or changes to tintinweb are required.

Install completion listeners **before** emitting spawn. A fast child can finish before the spawn reply arrives.
Correlate by the known child id, or by the unique token echoed in `description` before acceptance arrives, on either
terminal channel. **Consume immediately in that handler**, even for early failed output without a valid verdict nonce;
then retain one early terminal result and reconcile its id with the spawn reply. Description correlation is not an
authentication boundary between trusted extensions. Our subset must echo description too. The consume handler mutates
the flag synchronously even though its reply is asynchronous. Tintinweb emits the terminal event before checking that
flag ([`index.ts:584-597`][tw-terminal]), preventing a parent notification. Do not forward child progress, working
messages, or raw event payloads to builder context.

Other sharp edges and limits:

- Unknown option keys are silently dropped; use only the verified spellings above.
- Missing `requestId` falls back to `:reply:undefined`; this design never omits it.
- Protocol 2 did not bump when consume was added; ping alone does not prove consume exists. The supported baseline is
  the reviewed snapshot `ca93a52`, with consume coverage in contract tests. An older protocol-2 installation may fail
  notification suppression; surface that as incompatibility rather than claiming version 2 guarantees it.
- Agent frontmatter may override `isolated`; the supported deployment must leave the generic type's isolation unset or
  true. An explicit false cannot be fixed by the adapter. This is a documented limitation, not a builder-tool gate.
- Request IDs correlate replies; tintinweb does **not** promise idempotent spawn. On a lost acceptance reply, abort the
  signal and stop any known id, invalidate the attempt, and require confirmed terminal ownership before any fallback.
  Unknown acceptance stops automatic replacement for this logical review. Do not resend spawn or assume exactly-once.
- Optional upstream suggestions only: advertise consume support and an explicit resource-policy acknowledgement; add
  idempotent spawn lookup. Neither is a dependency of this design.

### 5.3 Our compatible subset (proposed PR P2)

Add the same four request channels and two terminal channels to our generic manager; register after session start and
unregister at shutdown. Reuse the existing creation/auth/cancellation path, with generic arguments mapped once:
`prompt → task`, `model → model`, `thinkingLevel → effort`, `inheritContext:false → contextMode:"none"`. Reject
unsupported inheritance rather than silently copying history. `isolated:true` must actually strip ambient resources and
recursive managers while retaining the minimal auth bridge. The exact resource-disable flags need implementation-time
verification; D's fresh-context mode alone is **not** resource isolation.

Use the existing direct-child registry and process owner, not a new execution engine. Emit final answer text
(`lastAssistantText`), never transcript tails. Provide compatible consume bookkeeping (no-op notification suppression
where our manager never auto-notifies), and stop the exact owned child on signal abort/stop. This path does not alter
the ordinary model-facing tool's default context/resource behavior. Unsupported workflow/profile options remain out of
scope. Nothing in the manager is review-aware.

### 5.4 Our wait return path (proposed PR P1; design approved)

Keep the existing `subagent action:"wait"` tool/action. Once settled, return **final status plus bounded
`lastAssistantText` only**, using the existing output bound; if absent, return a minimal no-final-answer status. Bound
the answer to the existing 45,000-character output limit; returned details must also omit task/transcript/stderr. A
wait-call timeout returns only a minimal still-running receipt (child id/state), not task text, transcript, or an old
assistant answer. It does not stop the child or indicate that the review-duration budget has expired. The existing
`status` action remains the explicit transcript diagnostic; do not add a tool, verbose parameter, tail protocol, or
another transcript API.

P1 changes the manager's own output at its source, not a router rewrite. It is independent of D: D controls conversation
sent **into** a child; P1 controls text returned **from** a child. Tests assert both settled and timed-out wait output
exclude task, transcript/tool traces, and stderr, and explicit status remains unchanged.

## 6. Parent child-task routing and builder-steered fallback

### 6.0 Resolve the child task's model and effort before creation (decided)

Construct the **actual child task** (including review instructions/evidence) in the parent, then run normal task
classification/routing policy against that task. Do not classify the current builder profile as a proxy, or select by
mechanism. Resolve one atomic `{model, effort}` tuple before any signaling spawn, builder dispatch, or SDK creation.

Reuse the router's existing classification transports and policy functions in decision-only form (for example
`classifyTaskWithPi`/its primary-secondary entry points and the applicable pure routing selectors). Do not call the
builder-route application/hot-swap path. No `pi.setModel`, `setThinkingLevel`, builder profile change, tool-loadout
change, or system-prompt rewrite is part of child selection. Existing primary/secondary/fallback policy and defaults
remain where applicable; no new child-specific classifier/model hierarchy is introduced.

Preserve current explicit-override precedence consistently for both fields: a caller-specified model remains fixed;
explicit effort wins over a model-string effort suffix; classify/select only missing fields; when both are explicit,
skip redundant model/effort inference. Resolve/authenticate the requested model and use existing capability
validation/clamping rules, reporting the resolved pair rather than silently replacing a caller override. A fallback may
fill missing values under normal policy; it may not override fixed ones. All paths receive the **complete explicit
pair**, so our manager's existing `selectModel` fast path (`extensions/subagents/index.ts:283–300`) performs no second
model classification. Keep ordinary manager behavior unchanged when callers omit fields; other managers must honor the
explicit pair through their supported options.

Selection is owned by the current **task generation and logical-review attempt**, with its abort signal and scope. Check
generation/signal before starting selection, after every await, and immediately before dispatch. A stale or cancelled
selection cannot publish a pair or launch a child. If a normal asynchronous correction completes before launch, commit
its pair atomically to that pending attempt; after creation do not retarget the child or builder. Reuse the completed
pair across safe mechanism fallback within that attempt, not a cross-task global model cache.

This is separate from **manager discovery** in section 6.1: discovery selects a usable tool/isolation path, uses
60-second SWR refresh, and can retain a stale observation. Child-task classification selects model/effort under normal
routing policy and the current review budget; it does not use the manager-discovery cache or inherit its timeout. No
extra redundant selection occurs inside an isolated reviewer child.

### 6.1 Stale-while-refresh classifier discovery (decided)

Use one classifier singleton in the extension factory closure, reset on reload/session replacement. It exposes the
**currently published observation**, including a successful no-match, while refreshing in the background. Retain the
publication with its source tool-set fingerprint; do not clear it when tools change. Discovery itself keeps
instance-local publication, current fingerprint, generation, DIRTY, and one eligible flight/controller. The separate
candidate-quarantine map in section 6.7 is not keyed by that whole-tool-set fingerprint. No process-global state or
retry timer.

Fingerprint the current tool inventory and active/callable membership from `pi.getAllTools()` and `pi.getActiveTools()`,
including schema, name, description, exposure, source, and guidelines. On a detected fingerprint change, abort the
previous flight (including a retry), increment generation, mark DIRTY, and begin one background classification for the
new inventory. If abort is ignored by the provider, its old promise is still ineligible to publish. An accessor detects
changes even when no previous flight exists.

Each field access returns the existing publication immediately. If DIRTY and no eligible flight exists, it starts
**exactly one** background refresh; concurrent accesses share that flight. With no publication yet, discovery is
unavailable for this review and resolution can use SDK; it does not block for classification. A cached no-match remains
visible during refresh just like a cached match.

The refresh has a **60-second deadline**, independent of the review-duration policy in section 6.9. Only a successful,
schema-valid answer from the current generation/fingerprint whose controller has not been aborted may publish (including
`none`) and clear DIRTY. Timeout aborts that flight, records telemetry, retains the publication, and leaves DIRTY. Other
unsuccessful classification attempts likewise do not publish. **Do not retry in catch/finally or on a timer:** the next
field access starts one background retry. A new tool change cancels that retry and advances generation again. Old
promise cleanup must not clear a newer flight.

The answer may name one real spawn tool and any result/wait tool, propose a **declarative parameter mapping/call plan**
grounded in the actual published schema, and identify documented no-router isolation with capability/docs references—or
report no usable match. Model-informed structured arguments are allowed; schema-grounded proposals are not forbidden
merely because a model supplied them. Treat schema text/output as untrusted data and bound both.

Keep the plan small: tool names, published argument names/nesting, schema-valid literals, and bindings for the concrete
parent-owned task, selected model, effort, isolation, and later returned child id. Only documented representations such
as an existing model/effort suffix may be used. Before dispatch, verify the named tool exists and is reachable, fill all
required fields, and validate the bound arguments against its current published schema. The parent supplies task
text/nonce and the resolved model/effort pair; the proposal cannot choose replacement values.

Schema validation proves input shape, **not semantics or isolation**. Establish supported no-router isolation for the
selected mode/agent from published capabilities/docs, not an appealing field name or the LLM's assertion. Without that
support use SDK. For a grounded, validated proposal, attempt invocation through normal supported execution and observe
what actually happens; high-confidence incompatible manager behavior can then quarantine the candidate (section 6.7).
This is classify/validate/try/quarantine, not a requirement to prove every operational behavior before trying.

No code-generation/eval/adapter plugin, arbitrary executable transformation, or invented manager protocol is needed.
Exclude quarantined candidate contracts from discovery input and reject repeated answers at publication/dispatch.

**Dispatch is a separate live check:** an old observation is not permission to call a disappeared or no-longer-callable
tool. Recheck the selected spawn/result tools against current availability and reachability (direct declaration or a
declared callable orchestration path). If unusable, fall forward while retaining the cached observation; no tool is
activated/deactivated. Revalidate a retained declarative plan against the current schema; a grounded mapping may be used
if its tools remain callable, isolation is supported, and its own contract is not quarantined. The builder uses those
concrete validated arguments through its normal tools; no router-side executable adapter is evaluated. Unrelated
inventory refresh must not reset that candidate's known execution incompatibility.

Tests must cover old match/none visible during refresh, newest generation wins, abort on tool change (including a
retry), ignored abort cannot publish, 60-second timeout marks DIRTY without eager retry, next access retries, concurrent
accesses single-flight, and successful no-match publication. Also test that quarantine exclusions survive unrelated
inventory changes and that old generations cannot republish an excluded candidate.

### 6.2 Dispatch

The router sends `pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" })`, where `message` is
`{ customType: "router-review-delegation", content, display: true }`, at a safe boundary chosen with B's run-boundary
rules. The content contains:

1. The exact reviewer task (prompt, evidence references, output contract) built by the router.
2. The validated declarative call plan, if discovery supplied one, with parent-selected concrete task/model/effort and
   supported isolation bound into schema-valid arguments. The builder can use this model-informed structured plan; it
   need not rediscover the mapping from scratch.
3. Generic delegation instructions:
   - use the classifier-identified tool `<name>` and its declared result/wait tool;
   - use the actually supported no-router isolation mechanism identified and checked during discovery;
   - fresh/no parent context where the tool supports it (independent of resource isolation);
   - the already parent-resolved model `<provider/id>` and effort `<level>`, both explicitly;
   - wait for the result inline (foreground or blocking);
   - do not request status, transcript, or verbose views;
   - do not act on the result beyond acknowledging it.

Use the existing supported execution workflow: ordinary event handlers have **no public direct `executeTool` API**
(§3.1), so the router delivers the validated plan to the builder for normal tool invocation. A model-informed call
through supported Pi dispatch is allowed; no new direct-execution API or executable adapter is implied. The fixed
signaling adapter continues to use its already documented event-bus protocol.

The following mappings are reference examples, **not proof every row is suitable for automatic review**. Isolation must
also pass section 6.6; our normal tool's `contextMode` does not qualify by itself. A proposed mapping may use only
arguments actually published by that tool:

| Manager                   | Fresh context                                        | Model and effort                                         | Inline result                            | Avoid                                                         |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| This repository (after D) | `contextMode: "none"`                                | `model`, `effort` (both set, which skips the classifier) | `create` then final-only `wait` after P1 | `status`, which returns transcript tail                       |
| tintinweb `Agent`         | `inherit_context: false` (default); `isolated: true` | `model`, `thinking`                                      | `run_in_background: false`               | `get_subagent_result verbose: true`; background notifications |
| nicobailon `subagent`     | `context: "fresh"`                                   | `model: "provider/id:effort"`                            | `async: false`                           | `status` with `view: "transcript"`                            |

The router task asks for exactly one final block, `<router-result nonce="N">{…json…}</router-result>`, where `N` is a
128-bit random value per attempt.

### 6.3 Observational result capture: no trimming (decided)

A `tool_result` handler scans text content, never the builder's paraphrase, for the last nonce-tagged JSON block
matching an open attempt and validating against the router schema. Match only the tools actually selected and
live-checked at dispatch; a refresh must not retarget an already open attempt. An echoed instruction/placeholder is not
a valid verdict. After P1 our wait stops echoing the task; third-party wrappers may still echo instructions.

Async capture occurs on the later selected wait/result call. Tintinweb background notification previews are custom
messages, not `tool_result`, and cannot substitute for the final result.

**DECISION-3 — RESOLVED: NO TRIMMING.** Parsing/validation is observational only. The router returns no content,
structured-content, detail, or error replacements for review results. Third-party manager wrappers/statistics remain in
the builder transcript exactly as returned. Invalid or late results are ignored for advice, not removed from context.

An attempt becomes stale before cancellation or fallback. Record late results without delivering their advice. There are
no same-mechanism launch retries. Apply the shared duration/ownership rules in section 6.9: a timeout is not proof that
a child stopped, and does not authorize a replacement long-running review. The router cannot directly cancel a
builder-launched child; if terminal ownership cannot be confirmed, stop automatic fallback for this logical review.

### 6.4 Context accounting: two independent directions

**Into the child:** `inheritContext:false` (signaling), `contextMode:"none"` (our tool after D), or a target tool's
fresh option excludes parent conversation. Resource selection is independent: `isolated:true` removes ambient
extensions, including the router. Fresh context is not filesystem, credential, or resource isolation.

**Back from the child:** signaling and SDK return privately to the router; raw child results and working context do not
enter builder context. Only subsequent router-authored advice does. No result rewriting is needed on these paths.

Builder-steered delegation adds its task prompt, orchestration calls, **unchanged manager output**, and builder
acknowledgement to parent context. P1 makes our wait return final status/answer only; status remains explicit transcript
diagnostics and must not be used for automatic review retrieval. Tintinweb verbose views, third-party status/transcript
actions, and wrapper text can still add context. The router does not strip it or claim strict non-leakage for unknown
managers. Fresh inbound context does not fix an outbound transcript leak.

Appends preserve the provider cached prefix when caching applies; cache reads can still cost and misses/expiry can
rebill input. Builder overhead is roughly `k × C_parent × p_cacheRead + new tail input + builder output`, with `k ≈ 2`
for foreground or `≈ 3` for spawn/wait. Signaling and SDK have `k = 0`. Discovery refresh/retry cost is separate: at
most one eligible flight at a time, with retries only on access.

### 6.5 Model, effort, telemetry, and UI

- The router passes its selected model and effort verbatim. A manager's fuzzy resolution or classifier must not replace
  them. Ours skips its classifier when both are set (`index.ts:283-291`).
- The router records requested and observed model. Observed is known only when the result text reports it (ours) or from
  signaling usage/events when supplied. Never claim an unreported effective model was verified.
- Telemetry fields: `review.path` (`in_process|builder|adapter`), `review.outcome`
  (`captured|fallback_timeout|fallback_invalid|no_delegate|late_result`), requested model and effort, `builder_turns`,
  reviewer usage when available.
- UI: one status line per attempt, and a note on fallback. No precedence or "manager detected" messaging. Child-task
  selection telemetry is tagged with its generation/attempt and does not overwrite the builder routing record.

### 6.6 No-router children and the bounded parent scheduling guard (decided)

Task-specific classification/model selection happens **in the parent before creation** (section 6.0). The child receives
an explicit model/effort tuple and loads **no router**. There is no child reviewer role/depth subsystem, startup marker,
opaque metadata API, inherited environment marker, or child-side routing/review scheduling. No review-of-review can
originate in that isolated child.

**Isolation is independent of fresh conversation.** A supported isolation mechanism must exclude the router/ambient
extensions, not merely omit history or restrict model tools. Discovery identifies an existing, documented mechanism from
the actual tool interface and records its evidence alongside the candidate. Check parameter/value support and known
semantics at dispatch. Model-proposed schema-grounded arguments are permitted, but do not invent unpublished fields or
infer router exclusion from field names, valid JSON, or task prose. If no supported no-router mechanism can be
established, the tool is unsuitable for **automatic router reviews** and resolution uses controlled SDK. This
suitability check chooses an internal runner; it never blocks builder tools or ordinary user-requested delegation.

| Path                                          | Supported isolation / limit                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared signaling, tintinweb and ours after P2 | Always pass `isolated:true` and `inheritContext:false`. P2 must actually suppress ambient resources/router. Tintinweb's verified generic-type configuration must honor isolation; frontmatter overriding it false makes that deployment unsuitable. No guessed metadata is sent.    |
| Controlled SDK                                | Explicit resource loader with `noExtensions:true`, no inline router factory, and only the reviewer tools/verdict tool. Assert the resulting session loads no router. Parent selection supplies both model and thinking level.                                                       |
| Our normal model-facing tool at base/after D  | `contextMode:"none"` excludes conversation only; it does not disable extensions. This tool is not an automatic-review fallback without a separately verified isolation option. Use our signaling subset after P2 or SDK; do not invent an `isolated` argument on the existing tool. |
| Other classifier-found tool                   | Its actual documented interface must provide no-router isolation. Tintinweb's normal `Agent` has `isolated:true`; any third-party foreground/resource policy must be verified for the selected mode/agent, not generalized to every profile. Otherwise use SDK.                     |

Known signaling and controlled SDK therefore guarantee no child router in supported configurations. Builder-steered
execution remains model-cooperative: instruct the verified mechanism and observe invocation arguments without blocking
ordinary tools. A deviation is an unusable review attempt, not permission to rewrite/block the call or launch an
unconfirmed overlapping replacement. Do not claim the same deterministic execution guarantee for builder cooperation.
Discovery may continue to publish an older observation during refresh, but automatic dispatch still rechecks both tool
reachability and supported isolation. A cached match never overrides a failed isolation check.

Keep only the **parent** lifecycle guard: one consumed logical-review slot per task generation, exact scope revision,
and stage (plan/completion), with at most one attempt per mechanism (three total in the fixed resolution chain). Reserve
before awaiting selection/spawn; check before scheduling plan/completion review and before review-triggered
continuation. Router-generated advice retains that existing logical review id and does not reopen a consumed stage, even
if the continuation is classified as high risk. No automatic review/repair retry or new reviewer from the same attempt.
Reuse parent session entries (`pi.appendEntry`, [custom entry API][pi-session-entry]) where needed to reconstruct
consumed stages on reload; do not add child lineage propagation.

Cancellation or generation replacement invalidates pending selection and launch. Late results cannot mutate a new task's
tuple, builder state, or advice. Ordinary manual tasks may establish a new parent task identity, but generated review
advice cannot. The guard controls internal scheduling only, never capabilities/tool execution.

Tests: child-task features, not builder profile, determine its pair; spawn sees both fields; parent model/profile and
cache prefix are unchanged; real child loads no router; cancellation before spawn launches nothing; generated advice and
its continuation cannot cause recursive spawn; stage/attempt slots remain bounded across reload.

Parent separately owns the factual tintinweb discovery/generic-compatibility issue. No marker feature or upstream change
is a prerequisite for this architecture.

### 6.7 Negative signaling discovery cache and candidate-specific quarantine (decided)

These are distinct states with different evidence. **There is no operational signaling circuit breaker and no
consecutive-transient-failure threshold on any mechanism.** State stays in the extension-instance closure and resets
with reload/session replacement; no process-global history, timer retry scheduler, arbitration, or probe redesign.

**Signaling negative discovery cache:** at most retain `noCompatibleSignaling` plus a bounded reason after completed
post-start discovery establishes no responder or no compatible signaling option (for example, a verified unsupported
ping version). A valid negative result skips signaling discovery for the rest of that instance. Do not cache success;
otherwise keep the existing per-review probe. An interrupted/errored probe or operational timeout is not verified
absence. Provider/startup errors, failed review tasks, bad reviewer JSON, cancellation, and stop/consume timing failures
do not establish protocol incompatibility and **must not permanently turn signaling off**. Fall forward for the current
review where ownership/budget permits; a later review can try signaling again. Only high-confidence evidence that no
compatible protocol option exists can produce the negative discovery cache, not an execution-failure counter.

**Classifier-discovered candidate quarantine:** remember a disproven tool only after a real invocation gives
high-confidence evidence that its advertised contract is incompatible with automatic review dispatch. Key it by:

- stable candidate identity: configured source identity (such as `sourceInfo.path`), namespace, and tool name;
- relevant candidate contract fingerprint: the canonical schema/constraints governing the invoked spawn arguments,
  exposure, and declared isolation/model/effort/final-result capabilities used by discovery. Include the selected
  companion result tool's relevant contract. Ignore unrelated optional fields, cosmetic schema titles/help text,
  formatting, and unrelated active tools; these cannot count as a meaningful contract change.

Examples sufficient for quarantine: a deterministic rejection of a required isolation/model/effort argument that the
tool claimed to support, or a deterministic incompatible dispatch/result contract attributed to the manager. A caller
inventing an unsupported argument, invalid model selection, provider rejection, review timeout, cancellation, weak
review quality, or a model's malformed verdict alone is **not** evidence the candidate lied about its contract.
Missing/non-callable tools and discovery guesses are handled by live eligibility checks, not execution quarantine.

Use one bounded reason/fingerprint record per candidate identity, no attempt log or transient counters. Retain it while
that contract is unchanged, including through unrelated tool-set changes, disappearance, and reappearance. Clear only
for a meaningful change to that candidate's relevant schema/capabilities (or lifecycle reset); changing an unrelated
tool must not rehabilitate it. A simple bounded map (at most 64 identities) is sufficient; if full, use SDK rather than
evict known failure evidence to keep retrying unremembered incompatible tools.

Exclude quarantined candidate fingerprints from classification selection, or reject a repeated answer at publication and
dispatch. A published stale observation stays recorded but is ineligible if quarantined. Adding quarantine changes
discovery eligibility: abort the existing flight, advance its generation, and mark DIRTY; the next field access can
start exactly one refresh with the exclusion. Old/aborted results cannot republish the candidate. An unrelated inventory
change still triggers ordinary SWR refresh, but does not erase candidate-specific evidence.

**Discovery timeout remains separate:** the 60-second classifier deadline records telemetry and DIRTY for a lazy
next-access retry. No invocation occurred, so it can never quarantine a candidate. Ordinary execution/provider errors
also do not create quarantine; a subsequent eligible review may retry that tool.

Telemetry distinguishes negative discovery, operational failure, candidate quarantine with fixed evidence reason,
contract-change invalidation, and classifier timeout/DIRTY. Current-attempt fallback still requires prelaunch failure or
confirmed terminal ownership and remaining review budget. Unknown cancellation does not authorize overlapping children.
If every option is unavailable, note it and continue the builder; no tool call is blocked.

### 6.8 Private-field acceptance, guard, and contract canary (proposed PR P5)

**DECIDED:** accept `Reflect.get(ctx.modelRegistry, "runtime")`. Do not replace C2 with a second hand-built loop. Guard
the presence and minimal expected callable shape before SDK construction. If absent/incompatible, disable SDK for this
extension lifetime, notify once ("in-process reviewer unavailable: Pi runtime contract changed"), and skip the review
rather than crash. This is a structural API-availability guard, not an operational-error breaker or transient counter.
Do not fall back to an unrelated default credential runtime or change the selected model.

Add a small offline executable test using a fake provider (no paid model/network call). It checks all Pi surfaces used
here, not merely the private field:

| Surface                                    | Canary assertion                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private model runtime and auth/model reuse | An actual extension context has `runtime`; it can be passed into a separate SDK session with the selected fake model.                                                                            |
| `getAllTools` and active tools             | Tool names, description, parameter schema, exposure, source metadata, and active-tool membership match the fingerprint assumptions.                                                              |
| `tool_result`                              | Observe real custom/nested tool payloads and nonce validation; assert parent content, structuredContent, details, and isError are unchanged by the router.                                       |
| Custom runs                                | `sendMessage(...,{triggerTurn:true})` fires `before_agent_start` with `messageType:"custom"`, and no double dispatch/reclassification occurs.                                                    |
| `createAgentSession`                       | Explicit model/effort, shared model runtime, in-memory settings/session manager, resource loader, tool selection, and custom tool are honored; ambient router is absent; abort/dispose clean up. |
| Event bus                                  | Reply microtasks and synchronous consume ordering match the adapter's tests; reload invalidates listeners and pending continuations.                                                             |

Propose `.github/workflows/pi-contract-canary.yml`: daily cron (e.g. `43 6 * * *`) plus `workflow_dispatch`, read-only
permissions, bounded runtime, and concurrency cancellation. Follow `patch-drift.yml`'s Node 24, npm registry/cooldown
handling, `persist-credentials:false`, and reviewed pinned actions:
`actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10` (v6) and
`actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38` (v6). **At implementation time**, check current versions
with `gh` and verify tags/versions against `teamupstart/Github_Org_Settings_TF`; this draft does not assume SHA pinning
satisfies the org allowlist.

Scheduled matrix: only the **1.2.0 floor** and **latest released Pi** (`@latest`, currently 1.3.0, within 1.x). The
pinned version stays covered by normal CI; do not add a broad historical matrix or use upstream main. In each scheduled
job, install `@earendil-works/pi-coding-agent@<matrix version>` without saving or changing a lockfile
(`npm install --no-save --package-lock=false --ignore-scripts`, latest lane uses `@latest`). Use a temporary
fixture/isolated prefix with coherent matching Pi peers, so devDependency pins cannot silently select the old package.
Resolve/report the tested version and check `>=1.2.0 <2.0.0` before treating the fixture as supported. If latest
resolves to a future 2.x (or another out-of-range release), flag an **unsupported upgrade investigation**, not a
successful compatibility promise or automatic support-range expansion. This is canary reporting, not npm enforcement or
a new installer upper gate. For in-range versions run the actual canary; fail on API drift. No dependency is installed
as part of this design change.

Keep this networked compatibility check out of prek/pre-commit hooks: daily/manual CI does not require network access on
every commit. Local and ordinary CI may run the canary against already installed pinned dependencies.

### 6.9 One review-duration budget, separate from discovery (decided constraints)

Classifier discovery has a fixed **60-second** refresh deadline. Review execution does **not** inherit it or another
fixed short timeout. Use the exact immutable review scope (base/head, commit range, staged/unstaged selection, and path
filters), not merely the current working tree.

Proposed simple function, with explicit constants:

```text
D = sum(added + removed text lines in the exact reviewed delta)
budget(D) = clamp(5 minutes + 1 minute * ceil(D / 100), 5 minutes, 4 hours)
```

The 5-minute floor and 4-hour ceiling are decided. The 1-minute/100-line slope is a documented **tunable proposal**, not
an approved calibrated predictor. Size estimates duration; it is not an effect/capability/risk classifier or tool gate.
Zero measurable changed lines gets 5 minutes.

Measure with native read-only git numstat, using NUL-delimited bounded parsing and the same revisions/path scope as the
review. Numeric added/removed counts measure text without a guessed language/effect classification. Proposed measurement
bounds: 5 seconds, 8 MiB output, and 10,000 records. Any binary (`-` counts), unavailable baseline,
incomplete/overflowed measurement, or unbounded non-repository scope uses **4 hours**, not a fabricated small delta.
Include committed changes when that is what is reviewed; if untracked/external evidence cannot be included exactly, use
the ceiling.

Compute one logical review deadline at scheduling and apply its remaining budget consistently to signaling,
builder-steered, and SDK paths. Fallback does not receive a new 5-minute–4-hour allocation. Background discovery has its
own timer and is never awaited as review execution; it does not reset the review clock. A wait call's shorter polling
timeout means still running, not review failure or review completion.

On budget expiry, mark the result stale before requesting cancellation. For signaling, abort signal and stop the known
id; acknowledgements alone do not prove physical terminal state. For SDK, abort/dispose and await supported
idle/cleanup. For builder-steered children, the router cannot directly cancel or establish termination from a wait
timeout. **Never start a replacement review while the prior child may still run.** At deadline expiry there is no review
budget left anyway: report timeout/unavailable and await cleanup or explicit operator action, not another long review.
Before-deadline failures may advance only after confirmed terminal ownership (or confirmed no launch); lost spawn
acceptance is uncertain and therefore stops automatic fallback for this logical review. Preserve late-result rejection
and synchronous consumption, even after cancellation.

Telemetry: scope id/revision, delta lines when known, allocated and remaining budget, measurement bounds outcome, and a
bounded fixed reason (`text_delta`, `binary`, `unavailable`, `measurement_limit`, `non_repository`). Never include raw
paths/diffs in that reason. Separately record classifier generation/fingerprint, timeout, DIRTY/refresh outcome, and
review cancellation/ownership confirmation. Tests cover exact committed scope, zero/large deltas, floor/ceiling,
binary/unavailable/limit fallback, shared deadlines across paths, stale late results, and no overlapping replacement
after unconfirmed cancellation.

## 7. Minimal generic contract

No review-specific public protocol is introduced: the public subset is tintinweb-compatible and generic. Inside the
router, C2's reserved seam stays one function:

```ts
// Router-internal. Generic: no review vocabulary.
type DelegatedRun = (req: {
  task: string; // full task text, including the router's output contract
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  deadlineMs: number; // same absolute logical-review deadline across runner paths
  signal: AbortSignal;
}) => Promise<{
  status: "completed" | "failed" | "timed_out" | "cancelled" | "unavailable";
  text?: string; // final answer only
  usage?: Usage;
  observedModel?: string;
}>;
```

Concrete consumers are the shared signaling adapter, the builder-steered runner, and C2's SDK runner. Parsing, nonce
checks, schema validation, epochs, and advice delivery stay outside the manager. A generic `resultSchema` option is
**not** proposed: nonce JSON in text works on every path. No nicobailon event adapter is planned.

## 8. Minimum and latest released support

Supported `@earendil-works/pi-coding-agent` range: **`>=1.2.0 <2.0.0`**, inclusive of 1.2.0—not `>1.2.0`. Target
**minimum + latest released**, not a historical matrix. Pi floor is **1.2.0**; npm latest released is currently
**1.3.0**, within the supported 1.x range. Scheduled canary covers those two lanes; normal CI covers the repo pin.
Upstream main remains source-research evidence only, never the latest release lane.

| Surface                                                             | Minimum verified / latest released target                                                       | Verification                                                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Custom runs, tool inventory, observational `tool_result`, event bus | Pi 1.2.0 / released 1.3.0                                                                       | Fake-provider canary, unchanged third-party result content, real custom-run preparation.                                                         |
| SDK runtime access and isolated resource loading                    | Pi 1.2.0 / released 1.3.0                                                                       | Runtime guard, parent-selection/no-child-router tests, abort/dispose. Private-field permission remains decided.                                  |
| Tintinweb package                                                   | Latest released **0.22.0**, release source `85a704cb8f35c96c0cabfa665b572bab296942e5`           | [Release wire source][tw-release-wire] verifies ping protocol **2**, spawn/stop/consume. Package and protocol versions are independent.          |
| Tintinweb compatible baseline                                       | Minimum **verified** package baseline 0.22.0; earlier minimum compatible release **unverified** | Reviewed release source plus `ca93a5247e72e7053fcd10bea7125d6c4205f949` docs/source snapshot. No guessed backward compatibility or legacy shims. |
| Our wait / signaling                                                | Proposed P1 / P2, absent at base                                                                | Final-only wait independent of D; protocol-2 subset requires D's fresh-input semantics.                                                          |
| pi-durable                                                          | Separate package; research only                                                                 | Not a runtime dependency or support-matrix lane.                                                                                                 |

Release metadata was checked with npm `dist-tags.latest` and GitHub `v0.22.0`, not inferred from a source package
version. Source `ca93a52` is a later reviewed snapshot with the same package version; it is not silently treated as
release bytes. Release/current source both have protocol 2 and consume. A verified unsupported ping version can yield an
instance-lifetime negative discovery cache, not an operational breaker. No assumption is made that every older
protocol-2 package supplies all required behavior.

**DECISION-4 — APPROVED:** document and declare `peerDependencies["@earendil-works/pi-coding-agent"]` as
`>=1.2.0 <2.0.0` for **both** `packages/pi-router-otel/package.json` and `packages/pi-subagents/package.json` (currently
`*`). The coordinator applies metadata and tests on the appropriate review-owned branch; floor execution checks remain
required before release. No manifests change here, no npm-runtime-enforcement claim, and no installer upper gate or
older-host shims. Canary tests assert range inclusion at 1.2.0/current 1.x and exclusion at 2.0.0; a future latest 2.x
must report unsupported-upgrade investigation rather than silently pass as supported.

### Current subagents package/API compatibility audit

Source audit uses floor SHA `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, not assumptions from latest docs:

| Actual use in our package                             | Pi 1.2.0 evidence and result                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK imports in `index.ts`                             | `getAgentDir`, `buildSessionContext`, `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`, and `ModelRuntime` are exported by [the floor barrel][floor-exports].                                                                                  |
| Compaction and context/session construction           | `noTools:"all"`, model/runtime/effort overrides, in-memory managers, loader resource-disable options, `compact(customInstructions)`, `abortCompaction`, and disposal exist. SDK, resource-loader, session-manager, and ModelRegistry files have no diff between 1.2.0 and 1.3.0. |
| Tool registration, UI, model/auth facade, auth bridge | `registerTool`, shutdown hook, `getThinkingLevel`, `isProjectTrusted`, provider registration, auth headers, and available-model lookup exist; extension types are identical at floor and 1.3.0. TUI `Text` export/component is unchanged.                                        |
| Utility inference and schema imports                  | Floor `pi-ai/compat` exports `completeSimple` and reexports `StringEnum` via `index.ts`/typebox helpers; compat is also an extension virtual module. Pi 1.2.0 supplies `typebox` 1.3.27 and requires Node ≥22.19.0, matching our package's Node floor.                           |
| Child launch flags and package entry                  | [Floor CLI parsing][floor-cli] supports every current launch flag: mode, session-dir, name, model, thinking, extension, approve/no-approve. Its packaged CLI is `dist/bundle/cli.js`, matching the integration fixture's resolution.                                             |
| Our `ManagedSubagent` wire operations/events          | [Floor RPC handling][floor-rpc] supports prompt, steer, follow_up, abort, get_state, and get_session_stats; settled/message/tool/queue/compaction events used by our parser are present. `helpers.ts` and process/tree cleanup use no extra Pi API.                              |

**Result:** no API/tool-use incompatibility found at 1.2.0; the source evidence supports the approved minimum. This is
not a claim that a live 1.2.0 package test was run here: no installed floor runtime was available and no dependencies
were installed. P1 release acceptance must run the existing deterministic RPC integration fixture against coherent 1.2.0
packages, plus extension load/create/compaction/auth-header/shutdown coverage and the floor canary. The latest released
lane remains separate. A test failure is a release blocker to fix, not an unresolved operator permission.

## 9. Upstream distillation

Adopt tintinweb's generic minimal signaling subset and final-only/explicit-diagnostic distinction; our extension
implements the subset and one router adapter serves both. Nicobailon remains conceptual inspiration (identity,
cancellation, context/output mode, usage) and a possible normal-tool target only; no event adapter is planned. The
durable-based coding-agent examples contribute the concrete comparisons in section 3.2: lifetimes, submission/result
identity, configuration versus conversation, output channels, model ownership, and recursion boundaries. Their reviewer
example does not itself supply structured verdicts or our bounded parent scheduling guard. This is forward-looking
inspiration, not a roadmap claim or runtime-adoption proposal. No upstream code is copied.

Do not adopt workflows, schedulers, missions, worktrees, role/profile frameworks, fleet UI, intercom/watchdogs,
persisted artifact frameworks, global registries, legacy dialect shims, review-specific manager protocols, or manager
arbitration. SWR generations and parent attempt/lifecycle guards are original design decisions using Pi's
lifecycle/session seams. Parent owns the separate factual tintinweb feature-request filing; no issue is filed by this
task.

## 10. Proposed PR layers (DRAFT; no implementation in this branch)

P1 is coordinator-owned #136. The operator authorized P0 publication, then P2 on published #136, P3 on P2, and P4 on P3
in separate worktrees/draft PRs. P3/P4 include the parent selection/lifecycle/budget work described below as P6; there
is no extra delivery layer required. P5 is separately assigned. Parallel A/B/C1/C2/D remain coordinator-owned. Parent
selection reuses normal routing, not a new model policy.

```text
P0 draft design ─► P1 final-only wait (host-range metadata separately coordinator-owned)
P0 + D ────────► P2 our compatible isolated signaling
C2 + A/B/C1 + P0 ► P3 router shared signaling adapter
P3 + P1 ───────► P4 SWR discovery + isolation-checked builder fallback
C2 + P0 ───────► P5 runtime guard + contract canary
P2 + P4 + P5 ──► P6 parent child-task selection / lifecycle / shared budget
```

P3 can be reviewed against tintinweb fixtures before P2. P6 waits for both. D controls inbound history; P1 controls
outbound output, so they stay independent. No child-lineage or opaque-startup API PR is needed.

| PR                                            | Scope and acceptance                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0                                            | DRAFT doc/attribution only; formatting passes.                                                                                                                                                                                                                                                                                                  |
| **P1 `subagents/final-only-wait`**            | Supported host `>=1.2.0 <2.0.0` (metadata/tests coordinator-owned), floor execution checks. Same wait: final status + bounded `lastAssistantText` (45,000-character limit), timeout = minimal still-running receipt. No task/transcript/stderr in content or details. Status unchanged; no tool/verbose/tail protocol.                          |
| P2 `subagents/tintinweb-compatible-signaling` | Four handlers and protocol-2 envelopes; generic task and explicit model/effort; fresh input and no-router isolation; final results/consume/signal/stop. Reuse manager lifecycle/auth; no second inference when both fields supplied; no review semantics.                                                                                       |
| P3 `router/shared-signaling`                  | Existing per-review probe except valid negative discovery cache; first reply, verified protocol/isolation, explicit pair, consume, cancellation/stale/ownership handling. Operational signaling errors never open a breaker. No builder state changes or extra turns.                                                                           |
| P4 `router/swr-builder-fallback`              | Closure SWR/60-second deadline/access-only retry. Schema-grounded declarative call plans with parent-bound values; existing builder/Pi dispatch only. Documented isolation plus candidate-specific execution quarantine; exclude disproven contracts while preserving SWR. No generated adapter code or result rewrites.                        |
| P5 `router/runtime-guard-and-pi-canary`       | Accepted private-field guard and isolated SDK fixture, no inline router or lineage bootstrap. Offline API canary; daily/manual floor+latest released installs, normal CI pin.                                                                                                                                                                   |
| P6 `router/parent-selected-review-lifecycle`  | Classify the actual child task under normal routing policy; atomically fix model+effort with existing overrides before creation. Generation-owned selection/cancellation, unchanged builder model/profile/cache prefix. Bounded parent stages/attempts and shared delta-scaled budget; no overlapping replacement after uncertain cancellation. |

### Acceptance tests

The durable examples sharpen existing tests: acceptance is not completion; cancelled wait is not stopped child;
configuration is not history; explicit model choice is an application concern. No additional PR or framework.

- P1: settled and timed-out output/details omit task/transcript/tool traces/stderr; timeout never returns an old answer.
  Status diagnostics unchanged; D remains independent; floor integration/auth/compaction/shutdown checks pass.
- P2/P3: exact wire/release fixtures, ping microtask, first reply, listener-before-emit, fast completion, consume,
  stop/signal, no resend/overlap on lost acceptance; actual isolation excludes the router. Explicit model+effort arrive
  unchanged and our manager classifier is not called again.
- P4: old publication while refreshing, newest generation wins, changed tools abort flights/retries, stale ignored abort
  cannot publish, timeout DIRTY/no eager retry, access retry, single-flight concurrency, valid none publication. Live
  missing/callability/isolation failure retains the observation but uses SDK. Accept a model-proposed, schema-grounded
  argument mapping, bind the parent's actual task/model/effort/isolation, and invoke through supported builder tools.
  Reject missing tools/required fields, invented arguments, invalid types, executable adapter code, and attempted direct
  dispatch from event handlers. A field named `isolated` without documented semantics cannot establish isolation. Test
  that a schema-valid plan can still reveal deterministic contract incompatibility on real invocation and enter
  candidate-specific quarantine; ordinary transient/task failure cannot. Third-party results stay unchanged.
- P3 **negative discovery vs operation:** verified no responder/no compatible option can be cached for the instance;
  provider/operational error, failed review, invalid reviewer JSON, and cancellation cannot set it. The next review
  probes signaling again after those failures; reload clears a valid negative cache. No consecutive-failure counter.
- P4 **candidate quarantine:** real deterministic required-argument/dispatch-contract rejection quarantines only that
  candidate contract; timeout, provider error, task-quality failure, bad reviewer JSON, caller mistake, missing tool,
  and discovery timeout alone do not. Reject repeated selection/publication/dispatch of quarantined fingerprints.
  Unrelated tools changing or the candidate disappearing/reappearing unchanged retain quarantine; meaningful candidate
  schema/capability change or reload clears it. Quarantine advances generation/aborts an old flight without eager retry;
  stale/aborted results cannot rehabilitate the candidate. Bounded-map overflow falls back without forgetting evidence.
- P5: isolated SDK loads no router, model/runtime/effort/tools honored, private-field drift yields a UI note not a
  crash; floor/latest released canary, no broad historical matrix. Range metadata/tests cover both package manifests;
  floor and current 1.x are in range, 2.0.0 is out. Future latest 2.x flags unsupported-upgrade investigation, not
  compatibility success or an installer upper gate.
- P6 **selection:** same builder profile with different child tasks yields task-appropriate pairs; explicit model only,
  effort only, suffix/effort precedence, both explicit (no redundant inference), and normal classifier fallback. Inspect
  spawn/SDK options for both fields; builder model, effort, profile, system prompt/tool loadout and cached prefix are
  unchanged (builder-steered dispatch appends its usual task message only).
- P6 **generation/lifecycle:** cancellation during selection or immediately before spawn launches nothing; superseded
  selection cannot publish or retarget a child; safe fallback reuses the tuple. A completed review/advice continuation
  cannot schedule a recursive spawn, even after high-risk reclassification/reload. Stage/attempt slots stay bounded.
- P6 **budget/ownership:** exact committed/working-tree scopes, bounded numstat, floor/ceiling/fallback reasons,
  remaining budget across paths, late stale results, and no overlapping replacement on uncertain termination.
  Discovery's 60-second timer is not a review or child-model-selection timeout.

### Deployment, rollback, and net simplification

P1 documents that transcript diagnostics require status. P6 changes default selection to manager-first for **suitable
isolated** runners, not every tool called “subagent.” Ordinary user delegation and default manager model selection for
omitted fields are unchanged. Deploy P2 before P6 when using our manager; tintinweb needs no changes.

Reuse parent session review-lifecycle entries for consumed stages on reload; add no child metadata migration. Test
one-manager/no-manager installations, pair propagation, builder state invariance, isolation, consumption, and cleanup.
Rollback P6 to the prior SDK-only path while retaining the bounded parent guard; P1 and scheduled canary can roll back
independently. There is no child lineage to migrate or reseed. Negative signaling discovery and candidate quarantine are
closure-local observations, reset at lifecycle replacement, with no persisted failure-counter migration.

The existing RPC framework remains the working baseline, not a prohibition on simplification: independent RPC and
thinking-level-helper investigations will determine any reuse/removal follow-ups. The separately delegated
`getPiInvocation` rename atop #136 changes naming only and adds no design PR here.

**Removed from the preceding design:** child role/depth records, env/bootstrap propagation, inline child-router loading,
per-child routing, and markerless-policy exception. **Retained:** one explicit pre-spawn model/effort pair, actual
isolation, SWR discovery, existing process/auth framework, and one bounded parent review lifecycle. No new generic
manager metadata API. The earlier ~0.6–1.0k runtime estimate remains provisional; deleting the lineage path reduces
code/test surface, with normal-routing reuse rather than a replacement framework.

## 11. Consequences

Signaling still costs no builder context/turn; builder fallback keeps its task/wrapper overhead and observational-only
capture. Child selection is based on the child task, not builder profile, and does not apply a model/profile/cache
switch to the parent. All automatic-review children load no router and use the selected tuple; no in-child
classification or reviewer lineage is required.

Manager discovery (60-second SWR) and child model/effort selection are separate. Review duration remains delta-scaled 5
minutes–4 hours. Unknown termination prevents replacement, not builder progress. If a discovered tool cannot supply
supported router-free isolation, controlled SDK is the automatic-review fallback; normal user delegation is untouched.
Isolation here excludes extensions, not operating-system credentials/filesystem access or sandbox guarantees.

## 12. Decisions: resolved and remaining

### Resolved (do not reopen)

- **DECISION-1/2:** shared signaling → classifier-discovered **suitable isolated** tool → SDK; first reply, no manager
  precedence/election, one tintinweb subset, no nicobailon event adapter.
- **Discovery:** closure SWR publication including none, tool-change abort/generation, 60-second deadline, timeout
  DIRTY, access-only retry, single flight, live callability and supported isolation checks. Model-informed declarative
  call plans grounded in published schemas are allowed; parent values are bound/validated, then normal Pi dispatch is
  attempted. No generated executable adapter, invented protocol, or unsupported direct event-handler invocation.
- **Child selection — DECIDED:** normal task classification/routing in parent on actual child task, model+effort
  together before spawn, existing explicit overrides/defaults, no redundant manager inference, generation-owned
  cancellation. Parent builder model/profile/cache prefix never switched.
- **DECISION-3:** no router result rewriting; observational validation only. P1 final-only wait approved, independent D.
- **DECISION-4:** router and subagents supported host peer range `>=1.2.0 <2.0.0`; metadata/tests coordinator-owned;
  floor execution tests before release. No npm-runtime-enforcement claim or new installer upper gate.
- **DECISION-5:** accept guarded private runtime; daily/manual floor+latest released canary, normal CI pinned version.
- **DECISION-6:** discovery/review clocks separate; shared delta-scaled 5-minute–4-hour review budget, unknown scopes
  use ceiling, no overlapping replacement without terminal proof. Exact slope remains tunable.
- **DECISION-7 — SUPERSEDED/RESOLVED:** no child router or reviewer lineage. Pre-spawn parent selection plus verified
  isolation and bounded parent stage/attempt/continuation guard replace it.
- **DECISION-9 — RESOLVED:** tool without established no-router isolation is unsuitable for automatic reviews; use SDK.
  This is internal runner selection, not builder tool enforcement or a restriction on ordinary delegation.
- **Failure state — RESOLVED:** no signaling operational breaker or consecutive transient thresholds. Only verified
  negative signaling discovery is instance-cached. Classifier candidates are quarantined after high-confidence execution
  incompatibility, keyed to their own identity/contract; unrelated inventory changes do not clear it. Discovery timeout
  remains DIRTY/lazy retry, never quarantine.
- Parent owns the factual tintinweb issue; no upstream metadata feature is required.

### Remaining choices / implementation checks

Only budget slope/measurement-limit tuning remains an operator choice; floor/ceiling and discovery deadline are fixed.
Implementation checks: real resource/isolation behavior including generic-type overrides, explicit tuple preservation
and existing routing precedence, parent generation cancellation, bounded cleanup, source floor tests, probe timing, and
org action allowlist. None calls for another lineage or generic metadata subsystem.

## 13. References

Pi (MIT): v1.2.0 `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, v1.3.0 `71023aec1546d6d677a65669c5665c0927ce0dd0`, main
`16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`. Installed runtime: Pi 1.3.0 under `~/.pi/agent/install/releases/1.3.0`.

[pi-session-entry]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/session-manager.ts#L1289-L1301
[tw-release-wire]:
  https://github.com/tintinweb/pi-subagents/blob/85a704cb8f35c96c0cabfa665b572bab296942e5/src/cross-extension-rpc.ts#L27-L199
[floor-exports]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/index.ts
[floor-cli]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/cli/args.ts#L96-L244
[floor-rpc]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L600
[pi-security]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/security.md
[pi-ext]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/extensions.md
[pi-sdk]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/sdk.md
[t-ctx]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/types.ts#L325-L395
[t-toolinfo]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/types.ts#L2122-L2130
[t-toolresult]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/types.ts#L1267-L1283
[t-send]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/types.ts#L1731-L1735
[as-getall]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/agent-session.ts#L1498-L1510
[as-send]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/agent-session.ts#L2318-L2350
[msgs]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/messages.ts#L162-L168
[evbus]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/event-bus.ts
[loader]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/loader.ts#L193-L200
[rl]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/resource-loader.ts#L379
[sdk-opts]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/sdk.ts#L49-L105
[mreg]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/model-registry.ts#L48-L138
[vmods]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/extensions/virtual-modules.ts#L1-L30
[rpcclient]:
  https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/modes/rpc/rpc-client.ts
[durable-handles]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L60-L134
[durable-settlement]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L379-L414
[durable-output]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L150-L193
[durable-agent]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L404-L474
[durable-coding-tools]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/tools/index.ts#L27-L39
[durable-readme]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md
[durable-abort]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#abort-and-subagents
[dx22]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/22-subagent-foreground.ts
[dx23]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/23-subagent-background.ts
[dx26]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/26-coding-agent.ts
[dx28]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/28-reviewer.ts
[tw-runner]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/agent-runner.ts#L1142-L1159
[tw-agent]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L1761-L1814
[tw-notify]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L466-L492
[tw-get]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L2979-L3045
[tw-wire]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/cross-extension-rpc.ts#L27-L111
[tw-spawn]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/cross-extension-rpc.ts#L110-L169
[tw-terminal]:
  https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts#L584-L597
[tw-rpc]: https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/docs/rpc.md
[nb-schema]:
  https://github.com/nicobailon/pi-subagents/blob/d48d580954086a426d31f1c7b8d793a1d26ad184/src/extension/schemas.ts#L236-L268
[nb-async]:
  https://github.com/nicobailon/pi-subagents/blob/d48d580954086a426d31f1c7b8d793a1d26ad184/src/extension/config.ts#L250-L251
[nb-fork]:
  https://github.com/nicobailon/pi-subagents/blob/d48d580954086a426d31f1c7b8d793a1d26ad184/src/shared/fork-context.ts#L83-L87
[nb-delegate]:
  https://github.com/nicobailon/pi-subagents/blob/d48d580954086a426d31f1c7b8d793a1d26ad184/agents/delegate.md
[nb-tr]:
  https://github.com/nicobailon/pi-subagents/blob/d48d580954086a426d31f1c7b8d793a1d26ad184/docs/tool-reference.md#L95-L96
[nb-deleg-doc]:
  https://github.com/nicobailon/pi-subagents/blob/d48d580954086a426d31f1c7b8d793a1d26ad184/docs/extension-api.md#L300-L433
