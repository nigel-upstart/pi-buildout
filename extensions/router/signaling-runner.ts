import { randomUUID } from "node:crypto";
import { newReviewNonce, parseReviewOutput, reviewOutputContract } from "./review-output.ts";
import type { ReviewRequest, ReviewResult, ReviewRunner } from "./review-runner.ts";

/**
 * Shared-signaling reviewer over the verified tintinweb `pi-subagents` 0.22.0 / protocol 2 bus subset.
 * Generic task launch only: review prompt, nonce parsing, and validation stay in the router.
 */
type Bus = {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
};
type Reply = { kind: "reply"; value: Record<string, unknown> } | { kind: "timeout" } | { kind: "invalid" };
type Terminal = { id: string; completed: boolean; result: string; usage: ReviewResult["usage"] };

/** Replies are microtasks on an in-process bus; a timer firing first means no responder. */
const PING_WAIT_MS = 1_000;
const CONTROL_WAIT_MS = 5_000;
const SPAWN_WAIT_MS = 120_000;
/** Shutdown waits this long for cancelled children's terminal events so they can still be consumed. */
const DRAIN_WAIT_MS = 2_000;
/** A cancelled or timed-out review waits this long for its child's terminal event to report billed usage. */
const USAGE_GRACE_MS = 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Fresh requestId, reply subscription before emit, bounded wait, and unsubscribe on settlement. `waiters`
 * lets disposal settle outstanding requests as timeouts, releasing their listeners and timers.
 */
function rpc(
  bus: Bus,
  waiters: Set<() => void>,
  method: string,
  fields: Record<string, unknown>,
  waitMs: number,
): Promise<Reply> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (reply: Reply) => {
      if (settled) return;
      settled = true;
      waiters.delete(abandon);
      off();
      clearTimeout(timer);
      resolve(reply);
    };
    const abandon = () => {
      settle({ kind: "timeout" });
    };
    waiters.add(abandon);
    const off = bus.on(`subagents:rpc:${method}:reply:${requestId}`, (data) => {
      const value = record(data);
      settle(value ? { kind: "reply", value } : { kind: "invalid" });
    });
    const timer = setTimeout(() => {
      settle({ kind: "timeout" });
    }, waitMs);
    try {
      bus.emit(`subagents:rpc:${method}`, { requestId, ...fields });
    } catch {
      settle({ kind: "invalid" });
    }
  });
}

function usageOf(value: unknown): ReviewResult["usage"] {
  const usage = record(value);
  const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? Math.max(0, field) : 0);
  return {
    cost: number(record(usage?.cost)?.total),
    inputTokens: number(usage?.input) + number(usage?.cacheRead) + number(usage?.cacheWrite),
    outputTokens: number(usage?.output),
  };
}

export type SignalingReviewRunner = ReviewRunner & {
  /** Verified absence/incompatibility for this extension instance; operational failures never set it. */
  readonly negative: string | undefined;
  /** Waits briefly for outstanding terminal events, then removes every remaining listener. */
  dispose(): Promise<void>;
};

export function createSignalingReviewRunner(bus: Bus | undefined): SignalingReviewRunner {
  let negative: string | undefined = bus ? undefined : "no_event_bus";
  const live = new Set<() => void>();
  const drained = new Set<() => void>();
  const waiters = new Set<() => void>();
  return {
    get negative() {
      return negative;
    },
    async dispose() {
      if (live.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          const done = () => {
            drained.delete(done);
            resolve();
          };
          drained.add(done);
          timer = setTimeout(done, DRAIN_WAIT_MS);
        });
        clearTimeout(timer);
      }
      for (const close of [...live]) close();
      // A lost acceptance settles as a timeout: abort, never resend, and never replace.
      for (const abandon of [...waiters]) abandon();
    },
    start(request: ReviewRequest) {
      const zero = { cost: 0, inputTokens: 0, outputTokens: 0 };
      const controller = new AbortController();
      const nonce = newReviewNonce();
      const description = `router review ${randomUUID()}`;
      let resolveResult!: (result: ReviewResult) => void;
      const result = new Promise<ReviewResult>((resolve) => {
        resolveResult = resolve;
      });
      let finished = false;
      // Cancellation or the deadline makes the attempt stale at once; its result waits briefly for usage.
      let stale: "timeout" | "cancelled" | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let spawnRequested = false;
      // Read through a function: cancellation and deadlines mutate this across awaits.
      const isSettled = () => finished;
      const isFinished = () => isSettled() || stale !== undefined;
      let childId: string | undefined;
      let early: Terminal | undefined;
      let observed = false;
      const offTerminal: (() => void)[] = [];
      const close = () => {
        for (const off of offTerminal.splice(0)) off();
        live.delete(close);
        if (live.size === 0) for (const done of [...drained]) done();
      };
      const finish = (status: ReviewResult["status"], extra: Partial<ReviewResult> = {}) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        resolveResult({ usage: zero, ...extra, status: stale ?? status });
        if (observed || status === "unavailable") close();
      };
      const stop = () => {
        controller.abort();
        if (bus && childId && !observed) void rpc(bus, waiters, "stop", { agentId: childId }, CONTROL_WAIT_MS);
      };
      const settle = (terminal: Terminal) => {
        if (stale) {
          // Stale advice is never delivered, but the spend it reports is still the task's.
          finish(stale, { usage: terminal.usage });
          return;
        }
        if (!terminal.completed) {
          finish("failed", { usage: terminal.usage });
          return;
        }
        const verdict = parseReviewOutput(terminal.result, nonce);
        finish(verdict === undefined ? "failed" : "completed", {
          usage: terminal.usage,
          ...(verdict === undefined ? {} : { verdict }),
        });
      };
      const onTerminal = (completed: boolean) => (data: unknown) => {
        const event = record(data);
        if (observed || !event || typeof event.id !== "string") return;
        if (childId ? event.id !== childId : event.description !== description) return;
        observed = true;
        // Synchronously, before any await: the manager checks this flag right after emit returns.
        if (bus) void rpc(bus, waiters, "consume", { agentId: event.id }, CONTROL_WAIT_MS);
        close();
        const terminal = {
          id: event.id,
          completed,
          result: typeof event.result === "string" ? event.result : "",
          usage: usageOf(event.usage),
        };
        if (childId || stale) settle(terminal);
        else early = terminal;
      };
      const expire = (status: "timeout" | "cancelled") => {
        if (finished || stale) return;
        // Stale before cancellation; stop acknowledgement is not proof of physical exit.
        stale = status;
        clearTimeout(timer);
        stop();
        // A manager may report its terminal before (or without) acceptance. Description correlation is
        // enough to retain billed usage for stale work, but never to deliver unaccepted advice.
        if (isSettled()) return;
        if (early) finish(status, { usage: early.usage });
        else if (!spawnRequested) finish(status);
        else
          graceTimer = setTimeout(() => {
            finish(status);
          }, USAGE_GRACE_MS);
      };
      const timer = setTimeout(
        () => {
          expire("timeout");
        },
        Math.max(1, request.timeoutMs),
      );
      void (async () => {
        if (!bus || negative) {
          finish("unavailable");
          return;
        }
        const ping = await rpc(bus, waiters, "ping", {}, PING_WAIT_MS);
        if (isFinished()) return;
        if (ping.kind === "timeout") {
          negative = "no_responder";
          finish("unavailable");
          return;
        }
        const version =
          ping.kind === "reply" && ping.value.success === true ? record(ping.value.data)?.version : undefined;
        // Only a well-formed success naming another protocol version proves incompatibility.
        if (typeof version === "number" && version !== 2) negative = "unsupported_protocol";
        if (version !== 2) {
          // Error envelopes and unexpected payloads fail this attempt only; the next review probes again.
          finish("unavailable");
          return;
        }
        // Terminal listeners precede spawn: a fast child can finish before its acceptance reply.
        live.add(close);
        offTerminal.push(bus.on("subagents:completed", onTerminal(true)));
        offTerminal.push(bus.on("subagents:failed", onTerminal(false)));
        spawnRequested = true;
        const spawn = await rpc(
          bus,
          waiters,
          "spawn",
          {
            type: "general-purpose",
            prompt: [
              request.systemPrompt,
              request.prompt,
              reviewOutputContract(nonce, request.kind, request.scopeFingerprint),
            ].join("\n\n"),
            options: {
              description,
              model: `${request.model.provider}/${request.model.id}`,
              thinkingLevel: request.effort,
              isolated: true,
              inheritContext: false,
              signal: controller.signal,
            },
          },
          Math.min(SPAWN_WAIT_MS, Math.max(1, request.timeoutMs)),
        );
        const accepted =
          spawn.kind === "reply" && spawn.value.success === true ? record(spawn.value.data)?.id : undefined;
        if (
          spawn.kind === "reply" &&
          spawn.value.success === false &&
          typeof spawn.value.error === "string" &&
          !early
        ) {
          // The manager reported a failed launch: no child is ours, so a fallback cannot overlap.
          close();
          finish("unavailable");
          return;
        }
        if (typeof accepted !== "string" || !accepted || (early && early.id !== accepted)) {
          // Lost or malformed acceptance: abort, keep listening to consume, and never resend.
          controller.abort();
          // Cancellation/deadline owns settlement now; a lost reply must not truncate its usage grace.
          if (!stale) finish("uncertain", { usage: early?.usage ?? zero });
          return;
        }
        childId = accepted;
        if (early) settle(early);
        else if (isFinished()) stop();
      })();
      return {
        result,
        cancel: () => {
          expire("cancelled");
        },
      };
    },
  };
}
