import { isDeepStrictEqual } from "node:util";
import { bindPlan } from "./discovery.ts";
import type { BoundCall, Observation, ToolView } from "./discovery.ts";
import { newReviewNonce, parseReviewOutput, reviewOutputContract } from "./review-output.ts";
import type { ReviewResult, ReviewRunner } from "./review-runner.ts";

/**
 * Builder-steered review delegation: the builder runs a validated call through its ordinary tools (event
 * handlers have no public `executeTool`). Results are observed, never rewritten or trimmed.
 */
type ToolCallEvent = { toolCallId: string; toolName: string; input: unknown };
type ToolResultEvent = ToolCallEvent & { content: readonly { type: string; text?: string }[]; isError: boolean };

// Deterministic rejection of a published argument by the manager itself, not an operational failure.
const CONTRACT_REJECTION =
  /\b(unknown|unsupported|unrecognized|unexpected|not supported|not allowed|additional propert(y|ies))\b/i;
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
    spawnCallId?: string;
    exact: boolean;
    finish(status: ReviewResult["status"], verdict?: unknown): void;
  };
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
      let call: BoundCall | undefined;
      try {
        const plan = deps.observe()?.plan;
        const tools = deps.tools();
        // A published observation is not permission: recheck reachability, schema, and isolation now.
        call = plan
          ? bindPlan(plan, tools, {
              task: [
                request.systemPrompt,
                request.prompt,
                reviewOutputContract(nonce, request.kind, request.scopeFingerprint),
              ].join("\n\n"),
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
        exact: false,
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
      if (attempt?.call.tool.name !== event.toolName) return;
      // A second spawn or changed arguments is a deviation: observed, never blocked or rewritten.
      attempt.exact = attempt.spawnCallId === undefined && isDeepStrictEqual(event.input, attempt.call.arguments);
      attempt.spawnCallId ??= event.toolCallId;
    },
    onToolResult(event: ToolResultEvent): void {
      const attempt = open;
      const spawn = attempt?.call.tool.name === event.toolName && event.toolCallId === attempt.spawnCallId;
      if (!attempt || (!spawn && attempt.call.result?.tool.name !== event.toolName)) return;
      const text = event.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
      const verdict = attempt.exact && !event.isError ? parseReviewOutput(text, attempt.nonce) : undefined;
      if (verdict !== undefined) {
        attempt.finish("completed", verdict);
        return;
      }
      if (!spawn) return;
      if (event.isError) {
        // The spawn call itself failed, so nothing of ours runs. Only an exact invocation whose rejection names a
        // bound argument is evidence the candidate's advertised contract is wrong.
        const named = Object.keys(attempt.call.arguments).some((key) => text.includes(key));
        if (attempt.exact && named && CONTRACT_REJECTION.test(text) && !OPERATIONAL.test(text))
          deps.quarantine(attempt.call, "argument_rejected");
        attempt.finish("failed");
        // A successful spawn without a verdict may have started a background child: never fall forward.
      } else if (!attempt.call.result) attempt.finish("uncertain");
    },
    /** The delegation run settled: no spawn means nothing launched; otherwise ownership is unknown. */
    onSettled(): void {
      const attempt = open;
      if (attempt) attempt.finish(attempt.spawnCallId === undefined ? "unavailable" : "uncertain");
    },
  };
}
