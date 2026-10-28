import { isDeepStrictEqual } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import { bindPlan } from "./discovery.ts";
import type { BoundCall, Observation, ToolView } from "./discovery.ts";
import { newReviewNonce, parseReviewOutput, reviewOutputContract } from "./review-output.ts";
import type { ReviewResult, ReviewRunner } from "./review-runner.ts";
import { validateSafetyReview } from "./core/safety.ts";

/**
 * Builder-steered review delegation: the builder runs a validated call through its ordinary tools (event
 * handlers have no public `executeTool`). Results are observed, never rewritten or trimmed.
 */
type ToolCallEvent = { toolCallId: string; toolName: string; input: unknown };
type ToolResultEvent = ToolCallEvent & {
  content: readonly { type: string; text?: string }[];
  isError: boolean;
  usage?: Usage;
};
const nonnegative = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
function reportedUsage(usage: Usage): ReviewResult["usage"] {
  return {
    cost: nonnegative(usage.cost.total),
    inputTokens: nonnegative(usage.input) + nonnegative(usage.cacheRead) + nonnegative(usage.cacheWrite),
    outputTokens: nonnegative(usage.output),
  };
}

// Deterministic rejection of a published argument *name* by the manager ("Unknown parameter: isolated"). Value errors
// ("Invalid parameter model: must be ...", "Unknown model: x") never match; the extracted name must be bound by us.
const REJECTED_ARGUMENT =
  /\b(?:unknown|unsupported|unrecognized|unexpected|disallowed)\s+(?:argument|parameter|option|property|field|key)s?\s*[:=]?\s*["'`]?([A-Za-z0-9_.-]+)|\badditional propert(?:y|ies)\s*[:=]?\s*["'`]?([A-Za-z0-9_.-]+)/gi;
function rejectedArguments(text: string): string[] {
  return [...text.matchAll(REJECTED_ARGUMENT)].flatMap((match) => {
    const name = match[1] ?? match[2];
    return name ? [name.replace(/[.,;:]+$/, "")] : [];
  });
}
const boundPaths = (value: unknown, prefix = ""): string[] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...boundPaths(child, `${prefix}${key}.`)])
    : [];
/**
 * The builder must reproduce every argument exactly, at builder output pricing and in builder context. Larger tasks
 * make exact reproduction unreliable, and a deviation blocks every fallback, so they use the SDK instead.
 */
const MAX_BUILDER_TASK_CHARS = 12_000;
/** Accounting only: cancellation/deadline stales advice immediately, but pending tool usage may arrive later. */
const ABORT_USAGE_GRACE_MS = 1_000;
const OPERATIONAL =
  /(not found|api key|auth|rate.?limit|quota|timed? ?out|timeout|unavailable|overloaded|network|validation failed for tool)/i;

export function createBuilderReviewRunner(deps: {
  observe(): Observation | undefined;
  tools(): ToolView[];
  blocked(call: BoundCall, tools: readonly ToolView[]): boolean;
  quarantine(call: BoundCall, reason: string): void;
  dispatch(content: string): void;
}) {
  type Attempt = {
    call: BoundCall;
    nonce: string;
    /** A verdict completes only if valid for this review kind and exact scope. */
    valid(verdict: unknown): boolean;
    spawnCalls: number;
    spawnCallId?: string;
    /** The first and only spawn matched the validated arguments exactly. */
    exact: boolean;
    /** Successful spawn output, used to correlate the companion call's child id. */
    spawnText?: string;
    resultCallId?: string;
    deviated: boolean;
    /** Provisional until the run settles: a later duplicate or deviation can still invalidate it. */
    verdict?: unknown;
    rejection?: string;
    spawnFailed: boolean;
    usage: ReviewResult["usage"];
    /** Accounting IDs are independent of the single spawn/wait IDs allowed to supply a verdict. */
    accounting: Map<string, { toolName: string; spawn: boolean; reported: boolean; reply?: string }>;
    stale?: "cancelled" | "timeout";
    finish(status: ReviewResult["status"], verdict?: unknown): void;
  };
  /** The validated companion template, where "<child id>" must be a string the spawn actually returned. */
  const matchesResult = (input: unknown, template: unknown, spawnText: string): boolean => {
    if (template === "<child id>") return typeof input === "string" && input.length > 0 && spawnText.includes(input);
    if (!template || typeof template !== "object" || !input || typeof input !== "object")
      return isDeepStrictEqual(input, template);
    const left = input as Record<string, unknown>;
    const right = template as Record<string, unknown>;
    const keys = Object.keys(right);
    return (
      Object.keys(left).length === keys.length &&
      keys.every((key) => Object.hasOwn(left, key) && matchesResult(left[key], right[key], spawnText))
    );
  };
  const textOf = (event: ToolResultEvent) =>
    event.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
  const addAccountingCall = (attempt: Attempt, event: ToolCallEvent, spawn: boolean): void => {
    if (attempt.accounting.has(event.toolCallId)) return;
    // Native nested IDs are <parent id>/<n>. A nested child cannot bill its ancestor's usage a second time.
    if ([...attempt.accounting.keys()].some((id) => event.toolCallId.startsWith(`${id}/`))) return;
    attempt.accounting.set(event.toolCallId, { toolName: event.toolName, spawn, reported: false });
  };
  const observeAccountingCall = (attempt: Attempt, event: ToolCallEvent): void => {
    const { call } = attempt;
    // A matching companion can use the same tool as the spawn. Account for every other selected-tool
    // invocation too, including a duplicate whose arguments deviate from the plan; none gains verdict trust.
    const companion =
      event.toolName === call.result?.tool.name &&
      [...attempt.accounting.values()].some(
        (entry) => entry.reply !== undefined && matchesResult(event.input, call.result?.arguments, entry.reply),
      );
    if (event.toolName === call.tool.name) addAccountingCall(attempt, event, !companion);
    else if (companion) addAccountingCall(attempt, event, false);
  };
  const observeAccountingResult = (attempt: Attempt, event: ToolResultEvent): void => {
    const entry = attempt.accounting.get(event.toolCallId);
    if (entry?.toolName !== event.toolName) return;
    // Pi tool_result usage is execution-local; outer transcript aggregates and unregistered nested IDs are ignored.
    if (event.usage && !entry.reported) {
      entry.reported = true;
      const usage = reportedUsage(event.usage);
      attempt.usage.cost += usage.cost;
      attempt.usage.inputTokens += usage.inputTokens;
      attempt.usage.outputTokens += usage.outputTokens;
    }
    // Keep only call correlation, never a verdict, while stale accounting drains. New companion calls may follow
    // a late spawn reply; they must still bind a child id returned by an actually validated spawn.
    if (entry.spawn && !event.isError && isDeepStrictEqual(event.input, attempt.call.arguments))
      entry.reply ??= textOf(event);
  };
  let open: Attempt | undefined;
  /** The dispatched run outlives a timed-out or cancelled attempt; only its settle clears this. */
  let runInFlight = false;
  const zero = { cost: 0, inputTokens: 0, outputTokens: 0 };
  const unavailable = () => ({
    result: Promise.resolve<ReviewResult>({ status: "unavailable", usage: zero }),
    cancel() {
      /* Nothing was dispatched. */
    },
  });
  const runner: ReviewRunner = {
    start(request) {
      // Never overlap a still-running delegation run, even after its attempt timed out or was cancelled.
      if (open || runInFlight) return unavailable();
      const nonce = newReviewNonce();
      const task = [
        request.systemPrompt,
        request.prompt,
        reviewOutputContract(nonce, request.kind, request.scopeFingerprint),
      ].join("\n\n");
      if (task.length > MAX_BUILDER_TASK_CHARS) return unavailable();
      let call: BoundCall | undefined;
      try {
        const plan = deps.observe()?.plan;
        const tools = deps.tools();
        // A published observation is not permission: recheck reachability, schema, and isolation now.
        call = plan
          ? bindPlan(plan, tools, {
              task,
              model: `${request.model.provider}/${request.model.id}`,
              effort: request.effort,
            })
          : undefined;
        if (call && deps.blocked(call, tools)) call = undefined;
      } catch {
        // Best-effort: any inventory/binding failure leaves this mechanism unavailable, never blocks the SDK.
        call = undefined;
      }
      if (!call) return unavailable();
      let resolveResult!: (result: ReviewResult) => void;
      const result = new Promise<ReviewResult>((resolve) => {
        resolveResult = resolve;
      });
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (status: ReviewResult["status"], verdict?: unknown) => {
        if (open !== attempt) return;
        open = undefined;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        attempt.accounting.clear();
        resolveResult({ status, usage: { ...attempt.usage }, ...(verdict === undefined ? {} : { verdict }) });
      };
      const attempt: Attempt = {
        call,
        nonce,
        valid: (verdict) => validateSafetyReview(verdict, request.kind, request.scopeFingerprint).success,
        spawnCalls: 0,
        exact: false,
        deviated: false,
        spawnFailed: false,
        usage: { ...zero },
        accounting: new Map(),
        finish(status, verdict) {
          if (open !== attempt || attempt.stale) return;
          if (status === "cancelled" || status === "timeout") {
            attempt.stale = status;
            attempt.verdict = undefined;
            clearTimeout(timer);
            // Even cancellation before the first call needs a grace: the builder's dispatched run cannot be stopped.
            drainTimer = setTimeout(() => {
              settle(status);
            }, ABORT_USAGE_GRACE_MS);
            return;
          }
          settle(status, verdict);
        },
      };
      // Deadline: the router cannot cancel a builder-launched child, so no replacement follows.
      const timer = setTimeout(
        () => {
          attempt.finish("timeout");
        },
        Math.max(1, request.timeoutMs),
      );
      open = attempt;
      runInFlight = true;
      deps.dispatch(
        [
          "Router review delegation (advisory; it blocks nothing and grants no permission).",
          `Call the \`${call.tool.name}\` tool exactly once with these validated arguments:`,
          "```json",
          JSON.stringify(call.arguments, null, 2),
          "```",
          ...(call.result
            ? [
                `Then call \`${call.result.tool.name}\` with these arguments, replacing "<child id>" with the returned id, and wait for the final result:`,
                "```json",
                JSON.stringify(call.result.arguments),
                "```",
              ]
            : []),
          "Wait for the result inline. Do not request status, transcript, or verbose views.",
          'Do not act on the result; reply only "Delegated review returned."',
        ].join("\n"),
      );
      return {
        result,
        cancel: () => {
          attempt.finish("cancelled");
        },
      };
    },
  };
  return {
    ...runner,
    onToolCall(event: ToolCallEvent): void {
      const attempt = open;
      if (!attempt) return;
      observeAccountingCall(attempt, event);
      if (attempt.stale) return;
      const { call } = attempt;
      // The companion call (possibly the same tool with a wait action) must match its validated template and
      // carry a child id the spawn returned. Anything else is a deviation: observed, never blocked or rewritten.
      if (call.result?.tool.name === event.toolName && attempt.spawnText !== undefined) {
        if (attempt.resultCallId === undefined && matchesResult(event.input, call.result.arguments, attempt.spawnText))
          attempt.resultCallId = event.toolCallId;
        else attempt.deviated = true;
        return;
      }
      if (call.tool.name === event.toolName) {
        attempt.spawnCalls++;
        attempt.spawnCallId ??= event.toolCallId;
        // Preserve accounting of an observed selected spawn even when its arguments deviated from the plan.
        addAccountingCall(attempt, event, true);
        attempt.exact = attempt.spawnCalls === 1 && isDeepStrictEqual(event.input, call.arguments);
      } else {
        // Any off-plan call (another agent tool, an early companion) may have launched something we cannot see.
        attempt.deviated = true;
      }
    },
    /** Recheck the executed input at tool_result, not merely the initially proposed tool_call input. */
    isValidatedOrchestration(event: ToolCallEvent): boolean {
      const attempt = open;
      if (!attempt || attempt.stale || !attempt.exact || attempt.spawnCalls !== 1) return false;
      if (event.toolCallId === attempt.spawnCallId && event.toolName === attempt.call.tool.name)
        return isDeepStrictEqual(event.input, attempt.call.arguments);
      return (
        event.toolCallId === attempt.resultCallId &&
        event.toolName === attempt.call.result?.tool.name &&
        matchesResult(event.input, attempt.call.result.arguments, attempt.spawnText ?? "")
      );
    },
    /** Record evidence only; every decision waits for the run to settle. */
    onToolResult(event: ToolResultEvent): void {
      const attempt = open;
      if (!attempt) return;
      observeAccountingResult(attempt, event);
      if (attempt.stale) return;
      const { call } = attempt;
      if (event.toolCallId === attempt.resultCallId) {
        // Later tool_call handlers may mutate input; trust only what actually executed.
        const executed = matchesResult(event.input, call.result?.arguments, attempt.spawnText ?? "");
        if (!executed) attempt.deviated = true;
        else if (!event.isError) attempt.verdict ??= parseReviewOutput(textOf(event), attempt.nonce);
        return;
      }
      if (event.toolCallId !== attempt.spawnCallId) return;
      if (!isDeepStrictEqual(event.input, call.arguments)) attempt.exact = false;
      const text = textOf(event);
      if (event.isError) {
        attempt.spawnFailed = true;
        attempt.rejection = text;
      } else if (attempt.exact) {
        attempt.verdict = parseReviewOutput(text, attempt.nonce);
        attempt.spawnText = text;
      }
    },
    /**
     * The delegation run settled (no more calls in it). A verdict counts only from one exact, undeviated spawn.
     * No calls, or exactly one verified failed spawn, allows fallback; a user abort always cancels.
     * Anything else, including a successful spawn without a verdict, leaves ownership unknown.
     */
    /** True from dispatch until the delegation run settles, regardless of the attempt's own outcome. */
    delegating(): boolean {
      return runInFlight;
    },
    onSettled(aborted = false): void {
      runInFlight = false;
      const attempt = open;
      if (!attempt || attempt.stale) return;
      const single = attempt.spawnCalls === 1;
      const trusted = single && attempt.exact && !attempt.deviated;
      if (aborted) attempt.finish("cancelled");
      // A recorded deviation never authorizes fallback: something unverified may still be running.
      else if (attempt.deviated) attempt.finish("uncertain");
      else if (attempt.spawnCalls === 0) attempt.finish("unavailable");
      // An invalid or foreign verdict from a launched child proves nothing about its termination: uncertain.
      else if (trusted && attempt.verdict !== undefined && attempt.valid(attempt.verdict))
        attempt.finish("completed", attempt.verdict);
      else if (trusted && attempt.spawnFailed) {
        // Only an exact invocation whose error rejects one of our bound argument names disproves the contract.
        const text = attempt.rejection ?? "";
        const ours = new Set(boundPaths(attempt.call.arguments));
        if (!OPERATIONAL.test(text) && rejectedArguments(text).some((name) => ours.has(name)))
          deps.quarantine(attempt.call, "argument_rejected");
        attempt.finish("failed");
      } else attempt.finish("uncertain");
    },
  };
}
