import { assign, createActor, enqueueActions, fromPromise, setup } from "xstate";
import type { ActorRefFrom } from "xstate";
import { changeEffortWithinLease, installLease, markManualOverride, setHardBoundary } from "./lease.ts";
import type { HardBoundary, LeaseState, RouterMode, TaskLease } from "./lease.ts";
import type { EffortLevel } from "./profiles.ts";

type SecondaryInput = { work: (signal: AbortSignal) => Promise<void> };

// The classifier is a child of the task family, not the temporary reviewer. Exiting running
// or stopping the child aborts its background work.
const secondaryMachine = setup({
  types: {
    context: {} as SecondaryInput,
    input: {} as SecondaryInput,
    events: {} as { type: "ABORT" },
  },
  actors: {
    classify: fromPromise(async ({ input, signal }: { input: SecondaryInput; signal: AbortSignal }) => {
      await input.work(signal);
    }),
  },
}).createMachine({
  context: ({ input }) => input,
  initial: "running",
  on: { ABORT: { target: ".stopped" } },
  states: {
    running: {
      invoke: { src: "classify", input: ({ context }) => context, onDone: "done", onError: "stopped" },
    },
    done: { type: "final" },
    stopped: { type: "final" },
  },
});

type LeaseTransition =
  | "ROUTE"
  | "PREPARE"
  | "FALLBACK"
  | "REVIEW_STARTED"
  | "REVIEW_FINISHED"
  | "SUBMIT_PLAN"
  | "SUBMIT_REVIEW"
  | "RECONCILE"
  | "REPAIR"
  | "EVIDENCE";

type LeaseAdvance = {
  type: LeaseTransition;
  lease: TaskLease;
  owner: TaskLease | undefined;
  epoch: number;
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
      return phase === "planning" && event.lease.lifecycle.phase === "planning";
    case "SUBMIT_REVIEW":
      return phase === "review" && event.lease.lifecycle.phase === "review";
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
  | { type: "INVALIDATE"; reason: string }
  | { type: "OVERRIDE"; effort?: EffortLevel }
  | { type: "RESET" }
  | { type: "START_SECONDARY"; owner: TaskLease; input: SecondaryInput }
  | { type: "ABORT_SECONDARY" };

type LeaseContext = {
  state: LeaseState;
  epoch: number;
  reviewEpoch: number | undefined;
  secondary: ActorRefFrom<typeof secondaryMachine> | undefined;
};

export function leaseFamily(lease: TaskLease | undefined): TaskLease | undefined {
  return lease?.lifecycle.phase === "review" && lease.parentLease ? lease.parentLease : lease;
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
      isAdvance(event) && validAdvance(event) && context.state.active === event.owner && context.epoch === event.epoch,
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
      const installed = installLease(context.state, event.lease);
      const pendingHardBoundary = context.state.pendingHardBoundary;
      enqueue.assign({
        // Only ROUTE, which installs the lease freshly selected for a boundary, consumes it. Every other
        // advance (evidence, fallback, repair, preparation, or a review hand-back) continues the same task
        // family, so a boundary such as compaction stays pending for the next ordinary input.
        state: freezeState(
          event.type !== "ROUTE" && pendingHardBoundary ? { ...installed, pendingHardBoundary } : installed,
        ),
        // Verdict submission and fallback replace the child without starting a new review.
        // Settlement's current epoch must never refresh the advice binding it started with.
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
  context: ({ input }) => ({
    state: freezeState(input),
    epoch: 0,
    reviewEpoch: undefined,
    secondary: undefined,
  }),
  initial: "selecting",
  on: {
    ROUTE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    PREPARE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    FALLBACK: { guard: "ownsLease", target: ".selecting", actions: "install" },
    REVIEW_STARTED: { guard: "ownsLease", target: ".selecting", actions: "install" },
    REVIEW_FINISHED: { guard: "ownsLease", target: ".selecting", actions: "install" },
    SUBMIT_PLAN: { guard: "ownsLease", target: ".selecting", actions: "install" },
    SUBMIT_REVIEW: { guard: "ownsLease", target: ".selecting", actions: "install" },
    RECONCILE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    REPAIR: { guard: "ownsLease", target: ".selecting", actions: "install" },
    EVIDENCE: { guard: "ownsLease", target: ".selecting", actions: "install" },
    RESTORE: {
      guard: ({ context, event }) => context.state.active === event.owner && context.epoch === event.epoch,
      target: ".selecting",
      actions: [
        "discardSecondary",
        assign({
          state: ({ event }) => freezeState(event.state),
          epoch: ({ context }) => context.epoch + 1,
          reviewEpoch: undefined,
        }),
      ],
    },
    MODE: {
      // A redundant mode command changes nothing, so it must not bump the epoch: that would make a valid
      // in-flight review verdict look stale and supersede an in-flight routing turn. Re-entering active mode
      // still applies when it clears a manual override.
      guard: ({ context, event }) =>
        context.state.mode !== event.mode ||
        (event.mode === "active" && (context.state.manualOverride || context.state.active?.manualOverride === true)),
      target: ".selecting",
      actions: assign({
        epoch: ({ context }) => context.epoch + 1,
        state: ({ context, event }) => {
          const state = context.state;
          // Keep the installed lease's identity unless entering active mode actually clears a manual override.
          // Awaiting handlers check ownership by identity, so a needless copy would look like a replaced owner
          // and strand work such as a finished review that only the epoch should have invalidated.
          const active =
            state.active && event.mode === "active" && state.active.manualOverride
              ? { ...state.active, manualOverride: false }
              : state.active;
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
      actions: ({ context }) => context.secondary?.send({ type: "ABORT" }),
    },
  },
  states: {
    selecting: {
      always: [
        { guard: ({ context }) => context.state.mode === "off", target: "off" },
        { guard: ({ context }) => !context.state.active, target: "idle" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "review", target: "review" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "planning", target: "planning" },
        { guard: ({ context }) => context.state.active?.lifecycle.phase === "completed", target: "completed" },
        { target: "execution" },
      ],
    },
    off: {},
    idle: {},
    planning: {},
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
    /** Whether the active review started in the current epoch and can still grant or restore authority. */
    get reviewBindingCurrent(): boolean {
      const current = actor.getSnapshot().context;
      return current.reviewEpoch !== undefined && current.reviewEpoch === current.epoch;
    },
    owns(lease: TaskLease | undefined, epoch: number): boolean {
      const current = actor.getSnapshot().context;
      return current.state.active === lease && current.epoch === epoch;
    },
    send(event: Exclude<LeaseEvent, LeaseAdvance>): void {
      actor.send(event);
    },
    advance(type: LeaseTransition, lease: TaskLease, owner: TaskLease | undefined, epoch: number): boolean {
      const before = actor.getSnapshot().context.state;
      actor.send({ type, lease, owner, epoch });
      const after = actor.getSnapshot().context.state;
      return after !== before && after.active === lease;
    },
  };
}
