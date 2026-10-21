import { isDeepStrictEqual } from "node:util";
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
type ToolResultEvent = ToolCallEvent & { content: readonly { type: string; text?: string }[]; isError: boolean };

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
  let open: Attempt | undefined;
  const zero = { cost: 0, inputTokens: 0, outputTokens: 0 };
  const unavailable = () => ({
    result: Promise.resolve<ReviewResult>({ status: "unavailable", usage: zero }),
    cancel() {
      /* Nothing was dispatched. */
    },
  });
  const runner: ReviewRunner = {
    start(request) {
      if (open) return unavailable();
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
      const attempt: Attempt = {
        call,
        nonce,
        valid: (verdict) => validateSafetyReview(verdict, request.kind, request.scopeFingerprint).success,
        spawnCalls: 0,
        exact: false,
        deviated: false,
        spawnFailed: false,
        finish(status, verdict) {
          if (open !== attempt) return;
          open = undefined;
          clearTimeout(timer);
          resolveResult({ status, usage: zero, ...(verdict === undefined ? {} : { verdict }) });
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
        attempt.exact = attempt.spawnCalls === 1 && isDeepStrictEqual(event.input, call.arguments);
      } else if (call.result?.tool.name === event.toolName) attempt.deviated = true;
    },
    /** Record evidence only; every decision waits for the run to settle. */
    onToolResult(event: ToolResultEvent): void {
      const attempt = open;
      if (!attempt) return;
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
     * No spawn, or exactly one failed spawn, launched nothing of ours and allows fallback; a user abort cancels.
     * Anything else, including a successful spawn without a verdict, leaves ownership unknown.
     */
    /** True while a dispatched delegation run is being observed. */
    delegating(): boolean {
      return open !== undefined;
    },
    onSettled(aborted = false): void {
      const attempt = open;
      if (!attempt) return;
      const single = attempt.spawnCalls === 1;
      const trusted = single && attempt.exact && !attempt.deviated;
      if (aborted) attempt.finish("cancelled");
      else if (attempt.spawnCalls === 0) attempt.finish("unavailable");
      // An invalid or foreign verdict from a launched child proves nothing about its termination: uncertain.
      else if (trusted && attempt.verdict !== undefined && attempt.valid(attempt.verdict))
        attempt.finish("completed", attempt.verdict);
      else if (single && attempt.spawnFailed) {
        // Only an exact invocation whose error rejects one of our bound argument names disproves the contract.
        const text = attempt.rejection ?? "";
        const ours = new Set(boundPaths(attempt.call.arguments));
        if (trusted && !OPERATIONAL.test(text) && rejectedArguments(text).some((name) => ours.has(name)))
          deps.quarantine(attempt.call, "argument_rejected");
        attempt.finish("failed");
      } else attempt.finish("uncertain");
    },
  };
}
