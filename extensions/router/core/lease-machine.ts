import { assign, createActor, enqueueActions, fromPromise, setup } from "xstate";
import type { ActorRefFrom } from "xstate";
import { changeEffortWithinLease, installLease, markManualOverride, setHardBoundary } from "./lease.ts";
import type { HardBoundary, LeaseState, RouterMode, TaskLease } from "./lease.ts";
import type { EffortLevel } from "./profiles.ts";

type SecondaryInput = { key: object; gated: boolean; work: (signal: AbortSignal) => Promise<void> };

function unresolvedSecondary(): SecondaryInput {
  return {
    key: {},
    gated: true,
    work: async () => {
      // A restored or reserved latch waits for fresh classification; it does not invoke a provider.
    },
  };
}

// The classifier is a child of the task family, not the temporary reviewer. Exiting running
// aborts its promise actor; an unanswered safety question survives cancellation when requested.
const secondaryMachine = setup({
  types: {
    context: {} as SecondaryInput,
    input: {} as SecondaryInput,
    events: {} as { type: "RESOLVE" } | { type: "RETAIN" } | { type: "ABORT"; retain: boolean },
  },
  actors: {
    classify: fromPromise(async ({ input, signal }: { input: SecondaryInput; signal: AbortSignal }) => {
      await input.work(signal);
    }),
  },
}).createMachine({
  context: ({ input }) => input,
  initial: "running",
  on: {
    RESOLVE: { actions: assign({ gated: false }) },
    RETAIN: {},
    ABORT: { target: ".stopped", actions: assign({ gated: ({ context, event }) => event.retain && context.gated }) },
  },
  states: {
    running: {
      invoke: { src: "classify", input: ({ context }) => context, onDone: "queued", onError: "stopped" },
    },
    queued: {},
    stopped: {},
  },
});

type LeaseTransition =
  | "ROUTE"
  | "PREPARE"
  | "FALLBACK"
  | "REVIEW_STARTED"
  | "REVIEW_FINISHED"
  | "SUBMIT_PLAN"
  | "SUBMIT_DISCOVERY"
  | "SUBMIT_REVIEW"
  | "RECONCILE"
  | "REPAIR"
  | "SPEND_DISCOVERY"
  | "EVIDENCE";

type LeaseAdvance = {
  type: LeaseTransition;
  lease: TaskLease;
  owner: TaskLease | undefined;
  epoch: number;
  secondarySafetyPending: boolean;
};

function isAdvance(event: LeaseEvent): event is LeaseAdvance {
  return "lease" in event;
}

function validAdvance(event: LeaseAdvance): boolean {
  const phase = event.owner?.lifecycle.phase;
  switch (event.type) {
    case "ROUTE":
      return true;
    case "REVIEW_STARTED":
      return phase !== "review" && event.lease.lifecycle.phase === "review" && event.lease.parentLease === event.owner;
    case "REVIEW_FINISHED":
      return phase === "review"
        ? event.owner?.parentLease?.taskId === event.lease.taskId
        : event.owner?.taskId === event.lease.taskId;
    case "SUBMIT_PLAN":
    case "SUBMIT_DISCOVERY":
      return phase === "preflight" && event.lease.lifecycle.phase === "preflight";
    case "SUBMIT_REVIEW":
      return phase === "review" && event.lease.lifecycle.phase === "review";
    case "SPEND_DISCOVERY":
      return phase === "discovery_ready" && event.lease.lifecycle.phase === "preflight";
    case "RECONCILE":
      return phase !== "review" && event.owner?.taskId === event.lease.taskId;
    case "PREPARE":
    case "FALLBACK":
    case "REPAIR":
    case "EVIDENCE":
      return event.owner?.taskId === event.lease.taskId;
  }
}

type LeaseEvent =
  | LeaseAdvance
  | { type: "RESTORE"; state: LeaseState; owner: TaskLease | undefined; epoch: number }
  | { type: "MODE"; mode: RouterMode }
  | { type: "INTENT" }
  | { type: "BOUNDARY"; boundary: HardBoundary }
  | { type: "INVALIDATE"; reason: string; discoveryOnly: boolean }
  | { type: "OVERRIDE"; effort?: EffortLevel }
  | { type: "RESET" }
  | { type: "START_SECONDARY"; owner: TaskLease; input: SecondaryInput }
  | { type: "ABORT_SECONDARY"; retain: boolean };

type LeaseContext = {
  state: LeaseState;
  epoch: number;
  reviewEpoch: number | undefined;
  secondary: ActorRefFrom<typeof secondaryMachine> | undefined;
};

export function leaseFamily(lease: TaskLease | undefined): TaskLease | undefined {
  return lease?.lifecycle.phase === "review" && lease.parentLease ? lease.parentLease : lease;
}

export function holdsDiscovery(lease: TaskLease): boolean {
  const lifecycle = lease.lifecycle;
  if (lifecycle.phase === "discovery_ready") return true;
  if (lifecycle.phase === "preflight") return lifecycle.discovery !== undefined;
  return (
    lifecycle.phase === "review" &&
    lease.parentLease?.lifecycle.phase === "preflight" &&
    lease.parentLease.lifecycle.discovery !== undefined
  );
}

export function revokeDiscovery(lease: TaskLease): TaskLease {
  if (!holdsDiscovery(lease)) return lease;
  const base = leaseFamily(lease) ?? lease;
  return {
    ...base,
    updatedAt: new Date().toISOString(),
    lifecycle: {
      phase: "preflight",
      policy: "authorization_then_completion_review",
      taskFingerprint: base.lifecycle.taskFingerprint,
    },
  };
}

/** Lifecycles that let the builder act on an independent approval: one discovery call or an exact plan. */
function grantsAuthority(lease: TaskLease): boolean {
  return lease.lifecycle.phase === "discovery_ready" || lease.lifecycle.phase === "authorized_execution";
}

export function invalidateAuthorization(lease: TaskLease, reason: string): TaskLease {
  if (holdsDiscovery(lease)) return revokeDiscovery(lease);
  const lifecycle = lease.lifecycle;
  if (!(
    lifecycle.phase === "authorized_execution" ||
    (lifecycle.phase === "completed" && lifecycle.policy === "authorization_then_completion_review" && lifecycle.plan)
  )) {
    return lease;
  }
  const now = new Date().toISOString();
  return {
    ...lease,
    updatedAt: now,
    lifecycle: {
      phase: "preflight",
      policy: "authorization_then_completion_review",
      taskFingerprint: lifecycle.taskFingerprint,
      ...(lifecycle.plan ? { plan: lifecycle.plan } : {}),
      lastAuthorizationReview: {
        kind: "authorization",
        completedAt: now,
        summary: `Authorization invalidated at ${reason}; the exact plan requires a fresh independent review.`,
      },
    },
  };
}

// Freeze the owned data, including nested review parents. Consumers can build candidate values,
// but cannot mutate a snapshot in place and bypass the transition guards.
function freezeState(state: LeaseState): LeaseState {
  const seen = new WeakSet();
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(state);
  return state;
}

const leaseMachine = setup({
  types: { context: {} as LeaseContext, input: {} as LeaseState, events: {} as LeaseEvent },
  actors: { secondary: secondaryMachine },
  guards: {
    ownsLease: ({ context, event }) =>
      isAdvance(event) &&
      validAdvance(event) &&
      context.state.active === event.owner &&
      context.epoch === event.epoch &&
      (event.type !== "REVIEW_FINISHED" ||
        event.owner?.lifecycle.phase !== "review" ||
        event.owner.lifecycle.reviewKind !== "authorization" ||
        context.reviewEpoch === context.epoch ||
        // A review that crossed a revocation boundary can never grant, but it must still hand control
        // back; otherwise the stale child lease would stay installed and block the task indefinitely.
        !grantsAuthority(event.lease)),
  },
  actions: {
    discardSecondary: enqueueActions(({ context, enqueue }) => {
      if (context.secondary) enqueue.stopChild(context.secondary);
      enqueue.assign({ secondary: undefined });
    }),
    install: enqueueActions(({ context, event, enqueue }) => {
      if (!isAdvance(event)) return;
      if (event.type === "ROUTE" || leaseFamily(context.state.active)?.taskId !== leaseFamily(event.lease)?.taskId) {
        if (context.secondary) enqueue.stopChild(context.secondary);
        enqueue.assign({ secondary: undefined });
      }
      if (event.type === "ROUTE" && event.secondarySafetyPending) {
        enqueue.assign({
          secondary: ({ spawn }) =>
            spawn("secondary", {
              input: unresolvedSecondary(),
            }),
        });
      }
      const installed = installLease(context.state, event.lease);
      const pendingHardBoundary = context.state.pendingHardBoundary;
      enqueue.assign({
        // Restoring a reviewed parent is a hand-back, not a fresh routing decision, so it must not
        // consume a hard boundary (for example compaction) that arrived while the review ran.
        state: freezeState(
          event.type === "REVIEW_FINISHED" && pendingHardBoundary ? { ...installed, pendingHardBoundary } : installed,
        ),
        // Verdict submission and fallback replace the child without starting a new review.
        // Settlement's current epoch must never refresh the authorization it started with.
        reviewEpoch:
          event.lease.lifecycle.phase !== "review"
            ? undefined
            : event.type === "REVIEW_STARTED"
              ? context.epoch
              : context.reviewEpoch,
      });
    }),
  },
}).createMachine({
  id: "routerLease",
  context: ({ input, spawn }) => ({
    state: freezeState(input),
    epoch: 0,
    reviewEpoch: undefined,
    secondary:
      input.active && input.secondarySafetyPending ? spawn("secondary", { input: unresolvedSecondary() }) : undefined,
  }),
  initial: "selecting",
  on: {
    ROUTE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    PREPARE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    FALLBACK: { guard: "ownsLease", target: ".selecting", actions: "install" },
    REVIEW_STARTED: { guard: "ownsLease", target: ".selecting", actions: "install" },
    REVIEW_FINISHED: { guard: "ownsLease", target: ".selecting", actions: "install" },
    SUBMIT_PLAN: { guard: "ownsLease", target: ".selecting", actions: "install" },
    SUBMIT_DISCOVERY: { guard: "ownsLease", target: ".selecting", actions: "install" },
    SUBMIT_REVIEW: { guard: "ownsLease", target: ".selecting", actions: "install" },
    RECONCILE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    REPAIR: { guard: "ownsLease", target: ".selecting", actions: "install" },
    SPEND_DISCOVERY: { guard: "ownsLease", target: ".selecting", actions: "install" },
    EVIDENCE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    RESTORE: {
      guard: ({ context, event }) => context.state.active === event.owner && context.epoch === event.epoch,
      target: ".selecting",
      actions: [
        "discardSecondary",
        assign({
          state: ({ event }) => freezeState(event.state),
          secondary: ({ event, spawn }) =>
            event.state.active && event.state.secondarySafetyPending
              ? spawn("secondary", { input: unresolvedSecondary() })
              : undefined,
          epoch: ({ context }) => context.epoch + 1,
          reviewEpoch: undefined,
        }),
      ],
    },
    MODE: {
      target: ".selecting",
      actions: assign({
        epoch: ({ context }) => context.epoch + 1,
        state: ({ context, event }) => {
          const state = context.state;
          const active = state.active
            ? { ...state.active, ...(event.mode === "active" ? { manualOverride: false } : {}) }
            : undefined;
          return freezeState({
            ...state,
            mode: event.mode,
            ...(event.mode === "active" ? { manualOverride: false } : {}),
            ...(active ? { active } : {}),
          });
        },
      }),
    },
    INTENT: { actions: assign({ epoch: ({ context }) => context.epoch + 1 }) },
    BOUNDARY: {
      actions: assign({
        state: ({ context, event }) => freezeState(setHardBoundary(context.state, event.boundary)),
        epoch: ({ context }) => context.epoch + 1,
      }),
    },
    INVALIDATE: {
      target: ".selecting",
      actions: assign({
        epoch: ({ context }) => context.epoch + 1,
        state: ({ context, event }) =>
          freezeState({
            ...context.state,
            ...(context.state.active
              ? {
                  active: event.discoveryOnly
                    ? revokeDiscovery(context.state.active)
                    : invalidateAuthorization(context.state.active, event.reason),
                }
              : {}),
          }),
      }),
    },
    OVERRIDE: {
      target: ".selecting",
      actions: [
        "discardSecondary",
        assign({
          epoch: ({ context }) => context.epoch + 1,
          state: ({ context, event }) => {
            let state = context.state;
            if (state.active && event.effort) {
              const changed = changeEffortWithinLease(state.active, event.effort, new Date().toISOString());
              if (changed.success) state = { ...state, active: changed.lease };
            }
            return freezeState(markManualOverride(state));
          },
        }),
      ],
    },
    RESET: {
      target: ".selecting",
      actions: [
        "discardSecondary",
        assign({
          state: ({ context }) =>
            freezeState(setHardBoundary({ mode: context.state.mode, manualOverride: false }, "new_session")),
          epoch: ({ context }) => context.epoch + 1,
        }),
      ],
    },
    START_SECONDARY: {
      guard: ({ context, event }) => context.state.active === event.owner,
      actions: [
        "discardSecondary",
        assign({ secondary: ({ event, spawn }) => spawn("secondary", { input: event.input }) }),
      ],
    },
    ABORT_SECONDARY: {
      actions: ({ context, event }) => context.secondary?.send({ type: "ABORT", retain: event.retain }),
    },
  },
  states: {
    selecting: {
      always: [
        { guard: ({ context }) => context.state.mode === "off", target: "off" },
        { guard: ({ context }) => !context.state.active, target: "idle" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "review", target: "review" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "preflight", target: "preflight" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "discovery_ready", target: "discovery" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "completed", target: "completed" },
        { target: "execution" },
      ],
    },
    off: {},
    idle: {},
    preflight: {},
    discovery: {},
    review: {},
    execution: {},
    completed: {},
  },
});

export function createLeaseOwner(initial: LeaseState) {
  const actor = createActor(leaseMachine, { input: initial }).start();
  return {
    get state(): LeaseState {
      return actor.getSnapshot().context.state;
    },
    get epoch(): number {
      return actor.getSnapshot().context.epoch;
    },
    /** Whether the active authorization review started in the current epoch and can still grant. */
    get reviewBindingCurrent(): boolean {
      const current = actor.getSnapshot().context;
      return current.reviewEpoch !== undefined && current.reviewEpoch === current.epoch;
    },
    owns(lease: TaskLease | undefined, epoch: number): boolean {
      const current = actor.getSnapshot().context;
      return current.state.active === lease && current.epoch === epoch;
    },
    get secondaryGated(): boolean {
      return actor.getSnapshot().context.secondary?.getSnapshot().context.gated ?? false;
    },
    send(event: Exclude<LeaseEvent, LeaseAdvance>): void {
      actor.send(event);
    },
    advance(
      type: LeaseTransition,
      lease: TaskLease,
      owner: TaskLease | undefined,
      epoch: number,
      secondarySafetyPending = false,
    ): boolean {
      const before = actor.getSnapshot().context.state;
      actor.send({ type, lease, owner, epoch, secondarySafetyPending });
      const after = actor.getSnapshot().context.state;
      return after !== before && after.active === lease;
    },
    settleSecondary(key: object, resolved: boolean): void {
      const secondary = actor.getSnapshot().context.secondary;
      if (secondary?.getSnapshot().context.key !== key) return;
      secondary.send({ type: resolved ? "RESOLVE" : "RETAIN" });
    },
  };
}
