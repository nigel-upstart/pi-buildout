# Classifier prompt experiment — 2026-08-13 (consequence under-reading)

[`eval-results-2026-08-13.md`](eval-results-2026-08-13.md) measured the classifier under-stating task consequence: three
`actionMode` under-reads across 18 golden fixtures with zero over-reads. That matters because both the `luna@medium`
`fast_classification` primary and the read-only confinement on the admitted scoped model gate on derived consequence, so
an under-read routes mutating work to a rung measured at 23.5% regression breakage, or admits a single-attempt-evidence
model to work it is meant to be excluded from.

Twelve prompt variants were measured against the existing prompt to see whether the bias was fixable in the prompt
rather than the policy.

## Measurement design

Two design problems had to be settled first, and both changed how the results should be read.

**The headline metric is too noisy to optimise against.** Four runs of the unchanged prompt produced `archetypeAccuracy`
of 0.778, 0.556, 0.778 and 0.833 — a 0.28 spread across identical inputs. Action-mode under-read counts over the same
runs were 3, 3, 3 and 2, and over-read counts were 0 every time. The under-read count is therefore the usable signal and
archetype accuracy is a guardrail that must not collapse, not a target.

**Minimising under-reads alone is degenerate.** A prompt that labelled everything `destructive` would score zero
under-reads and be useless. The objective is therefore to reduce under-reads without materially raising over-reads or
dropping archetype accuracy, with over-reads understood as the tolerable direction: they cost money by routing to a
stronger rung than needed, where under-reads cost safety.

A minimal-guidance control was added as variant 11 on operator instruction: the axis definitions with every mapping
heuristic deleted, keeping only the structural contract and the prompt-injection defence. Any real prompt has to beat
that floor to justify its own text. Note that `TaskFeaturesSchema` carries no field descriptions at all, so in the
current design every piece of semantic definition reaches the model through this prompt.

## Results

`under` and `over` are action-mode misreads in the unsafe and conservative directions. `mismatch` is total axis
mismatches across the corpus.

| Variant                       | under   | over | risk u/o | arch      | mismatch  |
| ----------------------------- | ------- | ---- | -------- | --------- | --------- |
| V0 existing prompt, 4 runs    | 3,3,3,2 | 0    | 1/1      | .556–.889 | 14–21     |
| V1 positive mutation licence  | 0       | 1    | 1/1      | .778      | 13        |
| V2 deliverable-not-probe      | 2       | 1    | 1/2      | .833      | 20        |
| V3 exclusive read-only clause | 0       | 1    | 1/1      | .889      | 12        |
| V4 positive external licence  | 2       | 0    | 1/1      | .833      | 13        |
| V5 bounded human checkpoint   | 1       | 0    | 1/1      | .833      | 11        |
| V6 explicit severity ordering | 2       | 0    | 1/1      | .889      | 10        |
| V7 V1 + V4                    | 2       | 0    | 1/1      | .833      | 13        |
| V8 V7 + V5                    | 1       | 0    | 1/0      | .833      | 11        |
| V9 V8 + V2                    | 1       | 0    | 1/1      | .889      | 14        |
| V10 V9 + V6                   | 1       | 0    | 1/1      | .833      | 11        |
| V11 minimal control           | 0       | 2    | 1/4      | .778      | 21        |
| **V12 V3 + V5**               | **0–1** | 0–1  | 1/1      | **.944**  | **10–11** |

V12 was not among the ten pre-registered variants. It was added once V3 and V5 turned out to fix different fixtures by
the same mechanism, and it is the adopted prompt. Its row reports three runs.

## What the results show

**The existing guidance was causing the bias, not failing to prevent it.** The minimal control, with every heuristic
deleted, produced zero under-reads where the full prompt produced three. That is the opposite of what accumulated
guidance is supposed to do.

The structural reason is visible in the prompt text. V0 contained exactly one `actionMode` mapping clause and it named
only the two read modes, offering no positive licence for `reversible_mutation`, `external_side_effect` or
`destructive`. Against that single permissive clause it stacked five suppressive ones — reserving
`program_unknown_size`, reserving high and critical risk, restricting `reviewIntent`, restricting multi-PR horizons, and
instructing that a human checkpoint means an external action is not destructive. The net pressure was downward, with no
counterweight, and the errors ran exactly that direction.

One clause named the failing fixtures almost verbatim, treating "release checklists, publish checkpoints, worktree
creation, and environment inspection" as `noncoding_tool_workflow`. It was written to fix `workflowType` and it bled
into `actionMode`, dragging `deliberate-workflow-001` and the worktree fixture read-ward.

**Removing suppression beat adding guidance, consistently.** Every replacement variant (V3, V5, V12) outperformed every
additive variant (V1, V4, V6, V7). The additive stacks plateaued at one or two under-reads no matter how much text was
added: V10 carried four extra clauses and still scored worse than V3, which added nothing and only made one existing
clause exclusive.

**The minimal control is safe but imprecise, which is why it is not adopted.** It reached zero under-reads by being
globally more willing to escalate, at the cost of four risk over-reads against V0's one and the joint-worst total
mismatch of 21. It establishes that the heuristics are not earning their place on the consequence axis; it does not
establish that deleting them is free elsewhere.

**V4 failing was as informative as V5 succeeding.** Adding a positive `external_side_effect` licence did not fix the
external fixture, while bounding the checkpoint clause did. The fixture was not failing for want of a definition; it was
failing because a specific clause told the model to stand down.

## Adopted change and its limits

Two clause replacements, no net prompt growth:

- The read-only clause becomes exclusive, so `information_only` and `local_read` are available only when the request
  asks for no change at all.
- The human-checkpoint clause now bounds authorization without lowering the action mode, so a gated publish stays
  `external_side_effect` and the checkpoint means not-yet-authorized rather than not-external.

Limits that should not be overstated:

- **Under-reads are reduced, not eliminated.** Across three runs V12 scored 0, 1 and 1. The first run alone would have
  suggested elimination; it does not replicate. `reversible_mutation` received as `local_read` survived in 8 of 12
  variants and in every V12 run. The likely remaining cause is the `noncoding_tool_workflow` clause, which still names
  worktree creation; bounding that clause the way V5 bounded the checkpoint is the obvious next lever and was not
  tested.
- **The `risk: critical` received as `medium` mismatch appears in every run of every variant**, including the minimal
  control. Nothing here addressed it, and since critical risk is a second input that raises consequence to irreversible,
  it is a live gap.
- **Most measurements are single runs on an 18-fixture corpus.** Differences of one under-read are inside the noise
  established by V0's own repeats and should not be treated as ordering evidence. Only V0 and V12 were run more than
  once.
- **The corpus was the tuning target.** Twelve variants scored against 18 fixtures invites overfitting to those
  fixtures. The gain should be re-checked against held-out tasks before it is trusted as general.

The stability result is worth separating from the accuracy result. V12 returned `archetypeAccuracy` 0.944 on three
consecutive runs where V0 ranged 0.556 to 0.889 and failed its own 0.8 assertion on repeat, so the adopted prompt also
makes the existing gate pass reliably rather than intermittently.

## Production-tier check

Every variant above ran against the eval's default classifier, `gpt-5.6-sol`, which is stronger than the production
classifier tiers. Re-running the endpoints of the comparison on `gpt-5.6-luna`, the production primary:

| on `gpt-5.6-luna` | under | over | arch | calib | mismatch |
| ----------------- | ----- | ---- | ---- | ----- | -------- |
| V0                | 2     | 0    | .889 | .360  | 13       |
| V12               | 1     | 0    | .833 | .506  | 13       |

The improvement holds in direction on the tier that actually runs: under-reads halve, calibration rises markedly, and
the `external_side_effect` miss that V0 shows is absent. Archetype accuracy is nominally lower but sits inside V0's own
measured spread on a single run, so it is not read as a regression. A repeat would be needed to separate the two.

## Consequence for the pending policy decision

This does not settle the `luna@medium` question recorded in [`decisions.md`](decisions.md). That decision's stated
reversal condition was action-mode accuracy worse than the 9.1%-to-23.5% breakage gap it traded on. A residual rate of
roughly one under-read in 18 on the strong classifier, and one in 18 on the production tier, is materially better than
the three this started from but is not zero, and the `risk: critical` miss is untouched. The prompt fix reduces the
exposure; it does not remove the reason the exposure matters.

## Reproducing

```sh
export BIFROST_BASE_URL=... BIFROST_VIRTUAL_KEY=... # never commit the key
ROUTER_EVAL_PROFILE_LIMIT=1 npm run test:eval:real  # add ROUTER_EVAL_PRIMARY_MODEL to change tier
```

Per-variant history is on the `exp/classifier-prompt` branch, one commit per variant with its scores in the commit
message.
