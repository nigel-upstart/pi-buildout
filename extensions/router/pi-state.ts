import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ARCHETYPES } from "./core/archetype.ts";
import type { Archetype } from "./core/archetype.ts";
import { validateFallbackTopology } from "./core/fallback.ts";
import { validateTaskFeatures } from "./core/features.ts";
import type { TaskFeatures } from "./core/features.ts";
import type { LeaseState, TaskLease } from "./core/lease.ts";
import { evidenceAbility } from "./core/evidence.ts";
import { ENDPOINT_TIERS, POLICY_VERSION, policyAbility } from "./core/policy.ts";
import type { EndpointTier } from "./core/policy.ts";
import { EFFORT_LEVELS, findPromptProfile } from "./core/profiles.ts";
import type { EffortLevel } from "./core/profiles.ts";
import { findEndpointHealth, isEndpointHealthRecord } from "./core/health.ts";
import type { EndpointHealthRecord } from "./core/health.ts";
import { canonicalVendor } from "./core/routing.ts";
import { matchesScope } from "./core/scope.ts";
import { isLeaseLifecycle, isSafetyEvidenceLog } from "./core/safety.ts";
import type { RegistryModelSnapshot, RouteRequirements } from "./core/routing.ts";
import type { RepositoryMetadata, SynopsisEntry } from "./core/synopsis.ts";

type ObjectLike = Record<string, unknown>;

function object(value: unknown): ObjectLike | undefined {
  return value !== null && typeof value === "object" ? (value as ObjectLike) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => object(part))
    .filter((part): part is ObjectLike => Boolean(part) && part?.type === "text")
    .map((part) => string(part.text) ?? "")
    .join("\n");
}

export function normalizeSessionEntries(entries: readonly unknown[]): SynopsisEntry[] {
  const result: SynopsisEntry[] = [];
  const toolPaths = new Map<string, string>();
  for (const rawEntry of entries) {
    const entry = object(rawEntry);
    if (!entry) continue;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const details = object(entry.details);
      const summary = string(entry.summary);
      result.push({
        kind: entry.type,
        ...(summary ? { text: summary } : {}),
        readFiles: stringArray(details?.readFiles),
        modifiedFiles: stringArray(details?.modifiedFiles),
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = object(entry.message);
    if (!message) continue;
    if (message.role === "user") {
      result.push({ kind: "user", text: contentText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const stopReason = string(message.stopReason);
      result.push({
        kind: "assistant",
        text: contentText(message.content),
        ...(stopReason ? { stopReason } : {}),
      });
      if (Array.isArray(message.content)) {
        for (const rawPart of message.content) {
          const part = object(rawPart);
          if (part?.type !== "toolCall") continue;
          const argumentsObject = object(part.arguments);
          const path = string(argumentsObject?.path);
          const id = string(part.id);
          if (path && id) toolPaths.set(id, path);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const toolCallId = string(message.toolCallId);
      const toolName = string(message.toolName);
      const path = toolCallId ? toolPaths.get(toolCallId) : undefined;
      result.push({
        kind: "tool",
        ...(toolName ? { toolName } : {}),
        ...(path ? { path } : {}),
        isError: message.isError === true,
      });
    }
  }
  return result;
}

function isRouteChoice(value: unknown, archetype: Archetype): boolean {
  const choice = object(value);
  if (
    !choice ||
    typeof choice.provider !== "string" ||
    typeof choice.modelId !== "string" ||
    (choice.vendor !== "openai" && choice.vendor !== "anthropic" && choice.vendor !== "google") ||
    typeof choice.effort !== "string" ||
    !EFFORT_LEVELS.includes(choice.effort as EffortLevel) ||
    typeof choice.profileId !== "string" ||
    typeof choice.contextWindow !== "number" ||
    typeof choice.ability !== "number" ||
    typeof choice.logicalModelId !== "string" ||
    !ENDPOINT_TIERS.includes(choice.endpointTier as EndpointTier)
  ) {
    return false;
  }
  return (
    findPromptProfile(choice.vendor, choice.modelId, archetype, choice.effort as EffortLevel)?.id === choice.profileId
  );
}

function isTaskLease(value: unknown, depth = 0): value is TaskLease {
  if (depth > 1) return false;
  const lease = object(value);
  if (!lease || typeof lease.archetype !== "string" || !ARCHETYPES.includes(lease.archetype as Archetype)) return false;
  const archetype = lease.archetype as Archetype;
  if (
    lease.version !== 2 ||
    typeof lease.taskId !== "string" ||
    typeof lease.startedAt !== "string" ||
    typeof lease.updatedAt !== "string" ||
    !validateTaskFeatures(lease.features).success ||
    !isRouteChoice(lease.selected, archetype) ||
    !Array.isArray(lease.fallbacks) ||
    !lease.fallbacks.every((choice) => isRouteChoice(choice, archetype)) ||
    !Number.isInteger(lease.attemptIndex) ||
    (lease.attemptIndex as number) < 0 ||
    (lease.attemptIndex as number) > lease.fallbacks.length ||
    (lease.previousSelection !== undefined && !isRouteChoice(lease.previousSelection, archetype)) ||
    (lease.parentTaskId !== undefined && typeof lease.parentTaskId !== "string") ||
    lease.leasePurpose !== undefined ||
    lease.reviewRequired !== undefined ||
    lease.reviewCompleted !== undefined ||
    !isLeaseLifecycle(lease.lifecycle) ||
    !isSafetyEvidenceLog(lease.safetyEvidence) ||
    (lease.lifecycle.phase === "review" &&
      (archetype !== "code_review" || lease.parentLease === undefined || lease.parentTaskId === undefined)) ||
    (lease.lifecycle.phase !== "review" && lease.parentLease !== undefined) ||
    (archetype === "code_review" && lease.lifecycle.phase !== "review" && lease.parentTaskId !== undefined) ||
    typeof lease.promptProfileId !== "string" ||
    object(lease.selected)?.profileId !== lease.promptProfileId ||
    typeof lease.modelSnapshotId !== "string" ||
    // A lease written by an earlier policy version predates fields that RouteChoice now declares
    // non-optional, so restoring it would produce a value whose type is a lie. Reject it and let the
    // next user turn create a fresh lease rather than degrading silently.
    lease.policyVersion !== POLICY_VERSION ||
    typeof lease.lastPromptFingerprint !== "string" ||
    typeof lease.manualOverride !== "boolean" ||
    (lease.planValidationRepairAttempted !== undefined && typeof lease.planValidationRepairAttempted !== "boolean")
  ) {
    return false;
  }
  const candidate = lease as unknown as TaskLease;
  if (validateFallbackTopology(candidate).length > 0) return false;
  if (lease.parentLease === undefined) return lease.parentTaskId === undefined || depth === 0;
  return (
    isTaskLease(lease.parentLease, depth + 1) &&
    lease.parentTaskId === lease.parentLease.taskId &&
    lease.lifecycle.taskFingerprint === lease.parentLease.lifecycle.taskFingerprint &&
    lease.parentLease.lifecycle.phase !== "review"
  );
}

export function restoreLeaseState(entries: readonly unknown[], defaultMode: LeaseState["mode"]): LeaseState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = object(entries[index]);
    if (entry?.type !== "custom" || entry.customType !== "model-router-state") continue;
    const data = object(entry.data);
    const mode = data?.mode === "off" || data?.mode === "shadow" || data?.mode === "active" ? data.mode : defaultMode;
    return {
      mode,
      ...(isTaskLease(data?.active) ? { active: data.active } : {}),
      manualOverride: data?.manualOverride === true,
    };
  }
  return { mode: defaultMode, manualOverride: false };
}

/**
 * The registry the router may choose from: every model the operator scoped in through
 * `enabledModels`, narrowed to the ones whose vendor the router supports, annotated with configured
 * availability and last observed health.
 *
 * Scope comes from settings rather than from a table in this repository, because the set of models a
 * machine can actually reach is the operator's decision and changes without this code changing.
 */
export function buildRegistrySnapshot(
  ctx: ExtensionContext,
  scope: RouterScope = EMPTY_SCOPE,
): RegistryModelSnapshot[] {
  const available = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
  const snapshots: RegistryModelSnapshot[] = [];
  for (const model of ctx.modelRegistry.getAll()) {
    const vendor = canonicalVendor(model.provider, model.id);
    if (!vendor) continue;
    if (!matchesScope(model.provider, model.id, scope.patterns)) continue;
    const health = findEndpointHealth(scope.health, model.provider, model.id);
    snapshots.push({
      ...(health ? { health } : {}),
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      vendor,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      available: available.has(`${model.provider}/${model.id}`),
      reasoning: model.reasoning,
      supportedEfforts: getSupportedThinkingLevels(model),
      inputTypes: model.input,
      toolCapable: !model.id.includes("realtime") && !model.id.includes("deep-research"),
      costPerMillion: { ...model.cost },
    });
  }
  return snapshots;
}

export type RouterScope = {
  /** `enabledModels` patterns. Empty means no scope is configured, so everything available is in scope. */
  patterns: readonly string[];
  health: EndpointHealthRecord | undefined;
};

export const EMPTY_SCOPE: RouterScope = { patterns: [], health: undefined };

/**
 * Reads the operator's model scope and the endpoint health record. Project settings win over user
 * settings, matching how pi resolves configuration. Every read is best-effort: a missing or malformed
 * file yields no scope and no health, which is the permissive default rather than an empty registry.
 */
export async function readRouterScope(cwd: string): Promise<RouterScope> {
  // An explicit override wins over settings. It exists so a run can be pinned to a known scope
  // without editing configuration, which tests rely on and operators can use for a one-off.
  const override = process.env.PI_ROUTER_MODEL_SCOPE;
  const overridePatterns =
    override === undefined
      ? undefined
      : override
          .split(",")
          .map((pattern) => pattern.trim())
          .filter((pattern) => pattern.length > 0);
  const [project, user] = await Promise.all([
    readJsonFile(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    readJsonFile(join(homedir(), ".pi", "agent", "settings.json")),
  ]);
  const patterns = stringArray(object(project)?.enabledModels);
  const fallbackPatterns = stringArray(object(user)?.enabledModels);
  const healthPath =
    process.env.PI_ROUTER_ENDPOINT_HEALTH_PATH ?? join(homedir(), ".pi", "agent", "router-endpoint-health.json");
  const health = await readJsonFile(healthPath);
  return {
    patterns: overridePatterns ?? (patterns.length > 0 ? patterns : fallbackPatterns),
    health: isEndpointHealthRecord(health) ? health : undefined,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function snapshotForModel(
  model: Model<Api> | undefined,
  registry: readonly RegistryModelSnapshot[],
): RegistryModelSnapshot | undefined {
  return model
    ? registry.find((candidate) => candidate.provider === model.provider && candidate.modelId === model.id)
    : undefined;
}

export function modelAbility(modelId: string, effort: EffortLevel): number {
  // Effort changes ability differently per model, so the policy candidate table in core/policy.ts is
  // authoritative whenever it knows the (model, effort) pair, and the evidence bands in
  // core/evidence.ts answer for measured models outside the current candidate set. The regex
  // heuristic below is only a last resort for models with no measurement at all.
  const known = policyAbility(modelId, effort) ?? evidenceAbility(modelId, effort);
  if (known !== undefined) return known;
  // Deliberately pessimistic and name-based only where a family name is a reliable capacity signal.
  // "pro" and "max" are not: gemini-3.1-pro-preview measured in the lowest band, and "max" appears
  // in effort labels rather than model capability.
  let ability = 2;
  if (/luna|haiku|nano|mini|flash|lite/.test(modelId)) ability = 1;
  if (/terra|sonnet/.test(modelId)) ability = 1;
  if (/sol|opus/.test(modelId)) ability = 3;
  if (modelId.includes("fable")) ability = 4;
  if ((effort === "xhigh" || effort === "max") && ability < 4) ability++;
  return ability;
}

export function estimateFinishedTokens(currentTokens: number, features: TaskFeatures): number {
  const responseAndReasoning = features.expectedAgentTurns * 1_500;
  const changeEvidence = features.expectedFilesChanged * 1_000;
  return Math.max(
    0,
    Math.ceil(currentTokens + features.expectedToolOutputTokens + responseAndReasoning + changeEvidence + 16_384),
  );
}

export function routeRequirements(
  currentTokens: number,
  features: TaskFeatures,
  hasImages: boolean,
): RouteRequirements {
  return {
    estimatedFinishedTokens: estimateFinishedTokens(currentTokens, features),
    requiresImages: hasImages,
    requiresTools: features.toolDependence !== "none",
  };
}

export function promptFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 5_000 });
    return result.code === 0 ? result.stdout.replace(/\s+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

// Coarse, bounded telemetry strata derived from Git-tracked file extensions. These buckets
// help compare route outcomes for similar repositories; they are not a language support
// allowlist, and unknown extensions are intentionally omitted rather than guessed.
function languageBuckets(files: readonly string[]): string[] {
  const buckets = new Set<string>();
  const names: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".mjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".rb": "ruby",
    ".swift": "swift",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
  };
  for (const file of files) {
    const bucket = names[extname(file).toLowerCase()];
    if (bucket) buckets.add(bucket);
  }
  return [...buckets].sort();
}

export async function readRepositoryMetadata(
  pi: ExtensionAPI,
  cwd: string,
  possibleReviewPrompt?: string,
): Promise<RepositoryMetadata> {
  const [root, head, upstream, status, tracked] = await Promise.all([
    git(pi, cwd, ["rev-parse", "--show-toplevel"]),
    git(pi, cwd, ["rev-parse", "HEAD"]),
    git(pi, cwd, ["rev-parse", "--verify", "@{upstream}"]),
    git(pi, cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    git(pi, cwd, ["ls-files"]),
  ]);
  const changedFiles = (status ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? line.slice(3));
  const trackedFiles = (tracked ?? "").split("\n").filter(Boolean).slice(0, 20_000);
  let reviewDelta: RepositoryMetadata["reviewDelta"];
  const pullRequestUrl = possibleReviewPrompt
    ? /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.exec(possibleReviewPrompt)?.[0]
    : undefined;
  const pullRequestNumber = possibleReviewPrompt
    ? /\b(?:pr|pull request)\s*#?(\d+)\b/i.exec(possibleReviewPrompt)?.[1]
    : undefined;
  if (
    possibleReviewPrompt &&
    (/\b(?:review|audit|inspect|look\s+over)\b/i.test(possibleReviewPrompt) || pullRequestUrl || pullRequestNumber)
  ) {
    const pullRequest = pullRequestUrl ?? pullRequestNumber;
    try {
      const result = pullRequest
        ? await pi.exec("gh", ["pr", "diff", pullRequest, "--patch"], { timeout: 10_000 })
        : await pi.exec("git", ["-C", cwd, "diff", "--no-ext-diff", "--unified=1", "HEAD", "--"], {
            timeout: 10_000,
          });
      if (result.code === 0 && result.stdout.trim()) {
        const patch = result.stdout;
        const files = [
          ...new Set(
            [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
              .map((match) => match[2] ?? match[1])
              .filter((file): file is string => typeof file === "string"),
          ),
        ].slice(0, 100);
        reviewDelta = {
          source: pullRequest ? "pull_request" : "working_tree",
          reference: pullRequestUrl ?? (pullRequestNumber ? `PR #${pullRequestNumber}` : "HEAD to working tree/index"),
          files,
          languageBuckets: languageBuckets(files),
          patchExcerpt: patch.slice(0, 4_000),
        };
      }
    } catch {
      // Review routing still uses the prompt and bounded repository metadata when the delta is unavailable.
    }
  }
  return {
    root: root ?? cwd,
    ...(head ? { head } : {}),
    ...(upstream ? { upstream } : {}),
    dirty: changedFiles.length > 0,
    changedFiles,
    languageBuckets: languageBuckets(trackedFiles),
    ...(reviewDelta ? { reviewDelta } : {}),
  };
}

export function latestReportedContextTokens(entries: readonly unknown[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = object(entries[index]);
    const message = object(entry?.message);
    if (entry?.type !== "message" || message?.role !== "assistant") continue;
    const usage = object(message.usage);
    const input = typeof usage?.input === "number" ? Math.max(0, usage.input) : 0;
    const cacheRead = typeof usage?.cacheRead === "number" ? Math.max(0, usage.cacheRead) : 0;
    const output = typeof usage?.output === "number" ? Math.max(0, usage.output) : 0;
    return Math.ceil(input + cacheRead + output);
  }
  return 0;
}

export function cacheEstimate(entries: readonly unknown[]): { cachedTokens: number; expectedReuseRatio: number } {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = object(entries[index]);
    const message = object(entry?.message);
    if (entry?.type !== "message" || message?.role !== "assistant") continue;
    const usage = object(message.usage);
    const cachedTokens = typeof usage?.cacheRead === "number" ? Math.max(0, usage.cacheRead) : 0;
    const input = typeof usage?.input === "number" ? Math.max(0, usage.input) : 0;
    return {
      cachedTokens,
      expectedReuseRatio: input > 0 ? Math.min(1, cachedTokens / input) : 0,
    };
  }
  return { cachedTokens: 0, expectedReuseRatio: 0 };
}
