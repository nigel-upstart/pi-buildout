import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "./helpers.ts";
import type { ThinkingLevel } from "./helpers.ts";
import type { ManagedSubagent } from "./rpc.ts";

/** Verified tintinweb 0.22.0/protocol 2 subset. No role or workflow semantics. */
type Spawn = {
  task: string;
  model: string;
  effort: ThinkingLevel;
  contextMode: "none";
  isolated: true;
  name?: string;
};
type Launch = (request: Spawn, ctx: ExtensionContext, signal: AbortSignal) => Promise<ManagedSubagent>;
type RecordState = {
  child: ManagedSubagent;
  description: string;
  terminal: boolean;
  consumed: boolean;
  stopRequested: boolean;
};
type Bus = ExtensionAPI["events"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value;
}
function spawnRequest(raw: Record<string, unknown>) {
  if (raw.type !== "general-purpose") throw new Error("Unsupported type; use general-purpose");
  const options = object(raw.options);
  if (options.isolated !== true || options.inheritContext !== false)
    throw new Error("Spawn requires isolated:true and inheritContext:false");
  if (!THINKING_LEVELS.includes(options.thinkingLevel as ThinkingLevel)) throw new Error("Unsupported thinkingLevel");
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("Invalid signal");
  return {
    task: required(raw.prompt, "prompt"),
    model: required(options.model, "model"),
    effort: options.thinkingLevel as ThinkingLevel,
    description: required(options.description, "description"),
    signal,
  };
}

/** CLI suppression is distinct from task-only context; explicit auth bridge is the sole extension. */
export function isolatedChildArgs(authBridge: string): string[] {
  return [
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    // SYSTEM.md and APPEND_SYSTEM.md are discovered separately from context files; empty values suppress both.
    "--system-prompt",
    "",
    "--append-system-prompt",
    "",
    "--extension",
    authBridge,
  ];
}

export function registerSignaling(events: Bus, ctx: ExtensionContext, launch: Launch): () => Promise<void> {
  const records = new Map<string, RecordState>();
  const controllers = new Set<AbortController>();
  const watchers = new Set<Promise<void>>();
  const unsubscribers: (() => void)[] = [];
  let closed = false;
  const isClosed = () => closed;
  const emitTerminal = (record: RecordState, status: "completed" | "stopped" | "aborted" | "error", error?: string) => {
    record.terminal = true;
    // Synchronous emit: a listener's consume request mutates `consumed` before this returns.
    events.emit(status === "completed" ? "subagents:completed" : "subagents:failed", {
      id: record.child.id,
      type: "general-purpose",
      description: record.description,
      status,
      result: status === "completed" ? (record.child.snapshot().finalAssistantText ?? "") : "",
      ...(error ? { error } : {}),
    });
  };
  type Terminal = [status: "completed" | "stopped" | "aborted" | "error", error?: string];
  const outcome = (record: RecordState, controller: AbortController): Terminal => {
    const snapshot = record.child.snapshot();
    if (controller.signal.aborted) return ["aborted", "Aborted"];
    if (record.stopRequested) return ["stopped", "Stopped"];
    if (snapshot.state === "idle") return ["completed"];
    return ["error", snapshot.error ?? "Child failed"];
  };
  const watch = async (record: RecordState, controller: AbortController) => {
    let terminal: Terminal | undefined;
    try {
      // Waiting timeout is not child termination. Repeat only the wait, never the launch.
      while (!isClosed() && !(await record.child.waitForIdle(3_600_000, controller.signal))) {
        /* Background task may run for hours. */
      }
      if (isClosed()) return;
      await record.child.refresh();
      if (!isClosed()) terminal = outcome(record, controller);
    } catch {
      const aborted = controller.signal.aborted;
      if (!isClosed()) terminal = aborted ? ["aborted", "Aborted"] : ["error", "Child failed"];
    } finally {
      // Signaling spawn is a single task, unlike the ordinary interactive child tool. Publish the terminal only
      // after the process tree is cleaned up, so a caller's fallback can never overlap this child.
      await record.child.stop();
    }
    if (terminal && !isClosed()) emitTerminal(record, ...terminal);
  };
  const spawn = async (raw: Record<string, unknown>) => {
    const request = spawnRequest(raw);
    const controller = new AbortController();
    controllers.add(controller);
    let child: ManagedSubagent | undefined;
    const abort = () => {
      controller.abort();
      if (child) void child.stop();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      child = await launch({ ...request, contextMode: "none", isolated: true }, ctx, controller.signal);
      if (closed || controller.signal.aborted) {
        await child.stop();
        throw new Error("Spawn cancelled");
      }
      const record = {
        child,
        description: request.description,
        terminal: false,
        consumed: false,
        stopRequested: false,
      };
      records.set(child.id, record);
      // Subscribe/watch before acceptance reply; completion may legitimately arrive first.
      const watching = watch(record, controller).finally(() => {
        request.signal?.removeEventListener("abort", abort);
        controllers.delete(controller);
        watchers.delete(watching);
      });
      watchers.add(watching);
      for (const [id, entry] of records) {
        if (records.size <= 32) break;
        if (entry.terminal) records.delete(id);
      }
      return { id: child.id };
    } catch (error) {
      request.signal?.removeEventListener("abort", abort);
      controllers.delete(controller);
      if (child) await child.stop();
      throw error;
    }
  };
  const own = (raw: Record<string, unknown>) => {
    const record = records.get(required(raw.agentId, "agentId"));
    if (!record) throw new Error("Agent not found");
    return record;
  };
  const handle = (method: string, action: (raw: Record<string, unknown>) => unknown) => {
    const channel = `subagents:rpc:${method}`;
    unsubscribers.push(
      events.on(channel, (input) => {
        // Never publish on the shared reply:undefined channel.
        if (!input || typeof input !== "object" || !("requestId" in input)) return;
        const raw = input as Record<string, unknown>;
        if (typeof raw.requestId !== "string" || !raw.requestId || raw.requestId.length > 128) return;
        const reply = `${channel}:reply:${raw.requestId}`;
        void (async () => {
          try {
            if (closed) throw new Error("No active session");
            // action runs synchronously until its first await: consume mutates before terminal emit returns.
            const data = await action(raw);
            if (!isClosed()) events.emit(reply, { success: true, ...(data === undefined ? {} : { data }) });
          } catch (error) {
            if (!isClosed())
              events.emit(reply, { success: false, error: error instanceof Error ? error.message : String(error) });
          }
        })();
      }),
    );
  };
  handle("ping", () => ({ version: 2 }));
  handle("spawn", spawn);
  handle("consume", (raw) => {
    const record = own(raw);
    if (!record.terminal) throw new Error("Agent not found or still running");
    record.consumed = true;
    // This manager does not auto-notify; consumption never injects parent context.
  });
  handle("stop", async (raw) => {
    const record = own(raw);
    if (record.terminal || record.stopRequested) throw new Error("Agent is not running");
    record.stopRequested = true;
    // Acknowledges the control request; the terminal event follows once the watcher observes it.
    await record.child.stop();
  });
  return async () => {
    closed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...records.values()].map(({ child }) => child.stop()));
    await Promise.allSettled(watchers);
    records.clear();
  };
}
