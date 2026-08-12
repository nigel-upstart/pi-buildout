import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ARCHETYPES } from "./core/archetype.ts";
import type { Archetype } from "./core/archetype.ts";
import { validateFallbackTopology } from "./core/fallback.ts";
import { validateTaskFeatures } from "./core/features.ts";
import type { TaskFeatures } from "./core/features.ts";
import type { LeaseState, RouterMode, TaskLease } from "./core/lease.ts";
import { evidenceAbility } from "./core/evidence.ts";
import { ENDPOINT_TIERS, POLICY_VERSION, policyAbility } from "./core/policy.ts";
import type { EndpointTier } from "./core/policy.ts";
import { EFFORT_LEVELS, findPromptProfile } from "./core/profiles.ts";
import type { EffortLevel } from "./core/profiles.ts";
import { ownProperty } from "./core/object-property.ts";
import { providerWeightFor, resolveProviderWeights, ROUTER_PROVIDER_WEIGHTS_ENV } from "./core/provider-weights.ts";
import type { ProviderWeightRejection, ResolvedProviderWeight } from "./core/provider-weights.ts";
import { findEndpointHealth, isEndpointHealthRecord } from "./core/health.ts";
import type { EndpointHealthRecord } from "./core/health.ts";
import { canonicalVendor, isStandaloneReviewRequest } from "./core/routing.ts";
import { canonicalModelId, isFlatRateProvider, matchesScope } from "./core/scope.ts";
import { isLeaseLifecycle, isSafetyEvidenceLog } from "./core/safety.ts";
import { localRepoKey, normalizeGitRemoteUrl, parseRouterMode, resolveStartMode } from "./core/start-mode.ts";
import type { StartModeResolution } from "./core/start-mode.ts";
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
    choice.logicalModelId !== canonicalModelId(choice.modelId) ||
    !ENDPOINT_TIERS.includes(choice.endpointTier as EndpointTier) ||
    (choice.endpointEffectiveCost !== undefined &&
      (typeof choice.endpointEffectiveCost !== "number" ||
        !Number.isFinite(choice.endpointEffectiveCost) ||
        choice.endpointEffectiveCost < 0)) ||
    (isFlatRateProvider(choice.provider) && choice.endpointEffectiveCost !== undefined)
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

/**
 * Whether this session branch already carries router state. A session that carries its own state
 * keeps it, so the configured start mode only decides what a session with no history starts as.
 */
export function hasPersistedRouterState(entries: readonly unknown[]): boolean {
  return entries.some((rawEntry) => {
    const entry = object(rawEntry);
    return entry?.type === "custom" && entry.customType === "model-router-state";
  });
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
      providerWeight: providerWeightFor(model.provider, scope.providerWeights),
    });
  }
  return snapshots;
}

export type RouterScope = {
  /** `enabledModels` patterns. Empty means no scope is configured, so everything available is in scope. */
  patterns: readonly string[];
  health: EndpointHealthRecord | undefined;
  /** Validated per-provider weights, including source and contract/preference basis metadata. */
  providerWeights: ReadonlyMap<string, ResolvedProviderWeight>;
  /** Best-effort configuration failures retained for the later diagnostics layer. */
  providerWeightRejections: readonly ProviderWeightRejection[];
};

const DEFAULT_PROVIDER_WEIGHTS = resolveProviderWeights();
export const EMPTY_SCOPE: RouterScope = Object.freeze({
  patterns: Object.freeze([]),
  health: undefined,
  providerWeights: DEFAULT_PROVIDER_WEIGHTS.weights,
  providerWeightRejections: DEFAULT_PROVIDER_WEIGHTS.rejections,
});

type RouterScopeReadOptions = {
  /** Injectable for isolated tests; production reads `process.env`. */
  environment?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  /** Injectable so tests never read the actual user's settings. */
  userSettingsPath?: string;
  /** Injectable so tests never read the actual endpoint-health record. */
  healthPath?: string;
};

/**
 * Reads model scope, endpoint health, and per-provider weights. Provider-weight precedence is
 * environment JSON, then project settings, then user settings, then built-ins, resolved independently
 * per provider. Every file read is best-effort.
 */
export async function readRouterScope(cwd: string, options: RouterScopeReadOptions = {}): Promise<RouterScope> {
  const environment = object(options.environment ?? process.env);
  // An explicit override wins over settings. It exists so a run can be pinned to a known scope
  // without editing configuration, which tests rely on and operators can use for a one-off.
  const override = string(ownProperty(environment, "PI_ROUTER_MODEL_SCOPE"));
  const overridePatterns =
    override === undefined
      ? undefined
      : override
          .split(",")
          .map((pattern) => pattern.trim())
          .filter((pattern) => pattern.length > 0);
  const userSettingsPath = options.userSettingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  const configuredHealthPath = string(ownProperty(environment, "PI_ROUTER_ENDPOINT_HEALTH_PATH"));
  const healthPath =
    options.healthPath ?? configuredHealthPath ?? join(homedir(), ".pi", "agent", "router-endpoint-health.json");
  const [project, user, health] = await Promise.all([
    readJsonFile(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    readJsonFile(userSettingsPath),
    readJsonFile(healthPath),
  ]);
  const patterns = stringArray(ownProperty(object(project), "enabledModels"));
  const fallbackPatterns = stringArray(ownProperty(object(user), "enabledModels"));
  const providerWeights = resolveProviderWeights({
    environmentValue: string(ownProperty(environment, ROUTER_PROVIDER_WEIGHTS_ENV)),
    projectSettings: project,
    userSettings: user,
  });
  return {
    patterns: overridePatterns ?? (patterns.length > 0 ? patterns : fallbackPatterns),
    health: isEndpointHealthRecord(health) ? health : undefined,
    providerWeights: providerWeights.weights,
    providerWeightRejections: providerWeights.rejections,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Global start-mode configuration: `{ "startMode": "last" | "off" | "shadow" | "active" }`. */
const ROUTER_CONFIG_FILE = "router-config.json";
/** Repository-scoped start-mode configuration, keyed by repository identity. */
const ROUTER_REPO_CONFIG_FILE = "repo-router-config.json";
/**
 * Where the mode in force at the last stop is recorded so `startMode: "last"` has something to read.
 *
 * Append-only, one JSON record per line, because several pi processes on one machine stop at
 * unpredictable times. A read-modify-write of a single JSON object would let the last writer drop
 * another repository's record; an append cannot lose a record it never read.
 */
const ROUTER_LAST_MODE_FILE = "router-last-mode.jsonl";

/**
 * Records kept when the log is compacted, and the length that triggers compaction. The log only needs
 * the most recent record per repository, so this bound keeps it small without needing exact history.
 */
const LAST_MODE_LOG_COMPACT_AT = 200;

/**
 * Repository identity used to key repository-scoped router configuration, resolved from git remotes
 * (`upstream`, then `origin`, then the first configured remote) and falling back to the repository
 * root path. Same key format as this repository's pi skills patch uses for `repo-skills.json`.
 */
export async function resolveRouterRepoKey(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  for (const remote of ["upstream", "origin"]) {
    const key = normalizeGitRemoteUrl(await git(pi, cwd, ["remote", "get-url", remote]));
    if (key) return key;
  }
  const remotes = (await git(pi, cwd, ["remote"]))?.split(/\r?\n/).map((name) => name.trim()) ?? [];
  const firstRemote = remotes.find(Boolean);
  const firstKey = firstRemote
    ? normalizeGitRemoteUrl(await git(pi, cwd, ["remote", "get-url", firstRemote]))
    : undefined;
  if (firstKey) return firstKey;
  return localRepoKey(await git(pi, cwd, ["rev-parse", "--show-toplevel"]), homedir());
}

function lastModePath(agentDir: string): string {
  return process.env.PI_ROUTER_LAST_MODE_PATH ?? join(agentDir, ROUTER_LAST_MODE_FILE);
}

type LastModeRecord = {
  version: 1;
  /** Absent for a record written outside any repository; such a record is the machine-wide fallback. */
  repoKey?: string;
  mode: RouterMode;
  updatedAt: string;
};

function parseLastModeRecord(line: string): LastModeRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A partially written line from a killed process is skipped, not fatal.
    return undefined;
  }
  const record = object(parsed);
  const mode = parseRouterMode(record?.mode);
  if (!record || !mode) return undefined;
  const repoKey = string(record.repoKey);
  return {
    version: 1,
    ...(repoKey ? { repoKey } : {}),
    mode,
    updatedAt: string(record.updatedAt) ?? "",
  };
}

async function readLastModeLog(agentDir: string): Promise<LastModeRecord[]> {
  let content: string;
  try {
    content = await readFile(lastModePath(agentDir), "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseLastModeRecord(line))
    .filter((record): record is LastModeRecord => record !== undefined);
}

/**
 * The mode recorded at the last stop. A record for this repository wins over the machine-wide one so
 * enabling routing in one checkout does not silently enable it everywhere.
 */
async function readLastKnownMode(agentDir: string, repoKey: string | undefined): Promise<RouterMode | undefined> {
  const records = await readLastModeLog(agentDir);
  if (repoKey) {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record?.repoKey === repoKey) return record.mode;
    }
  }
  // No record for this repository: the newest record of any scope is the machine-wide fallback.
  return records.at(-1)?.mode;
}

/**
 * Records the mode currently in force by appending one line, so a concurrent pi process recording a
 * different repository cannot overwrite this record or have its own dropped. The log is compacted to
 * the newest record per repository once it grows past a bound.
 */
export async function writeLastKnownMode(
  agentDir: string,
  repoKey: string | undefined,
  mode: RouterMode,
): Promise<void> {
  const path = lastModePath(agentDir);
  const record: LastModeRecord = {
    version: 1,
    ...(repoKey ? { repoKey } : {}),
    mode,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  await compactLastModeLog(agentDir, path);
}

/**
 * Rewrites the log with only the newest record per repository. Best-effort and deliberately silent: a
 * failed compaction only means the log stays long. A record appended by another process during the
 * rewrite window can be lost, which at worst makes one repository fall back to the machine-wide mode
 * on its next start; compaction runs about once per few hundred session ends, so that window is rare
 * and the mode is re-recorded at the next change or shutdown.
 */
async function compactLastModeLog(agentDir: string, path: string): Promise<void> {
  const records = await readLastModeLog(agentDir);
  if (records.length < LAST_MODE_LOG_COMPACT_AT) return;
  const newest = new Map<string, LastModeRecord>();
  for (const entry of records) newest.set(entry.repoKey ?? "", entry);
  const kept = [...newest.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true });
  }
}

/**
 * Resolves the mode a session with no router state of its own should start in, reading the
 * environment override, the repository-scoped configuration entry, the global configuration file, and
 * the recorded exit mode. Every read is best-effort: unreadable configuration yields the default
 * preference (`last`) rather than an error, because start mode must never block a session.
 */
export async function readStartModeResolution(input: {
  agentDir: string;
  repoKey: string | undefined;
}): Promise<StartModeResolution> {
  const { agentDir, repoKey } = input;
  const [globalConfig, repoConfig, lastKnownMode] = await Promise.all([
    readJsonFile(join(agentDir, ROUTER_CONFIG_FILE)),
    readJsonFile(join(agentDir, ROUTER_REPO_CONFIG_FILE)),
    readLastKnownMode(agentDir, repoKey),
  ]);
  const repoEntry = repoKey ? object(ownProperty(object(repoConfig), repoKey)) : undefined;
  return {
    ...resolveStartMode({
      envMode: process.env.PI_ROUTER_MODE,
      repoStartMode: repoEntry?.startMode,
      globalStartMode: object(globalConfig)?.startMode,
      lastKnownMode,
    }),
  };
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

/** Pure patch parsing, kept separate from the command execution that produces the patch. */
function parseReviewDelta(
  patch: string,
  source: NonNullable<RepositoryMetadata["reviewDelta"]>["source"],
  reference: string,
): NonNullable<RepositoryMetadata["reviewDelta"]> {
  const files = [
    ...new Set(
      [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
        .map((match) => match[2] ?? match[1])
        .filter((file): file is string => typeof file === "string"),
    ),
  ].slice(0, 100);
  return { source, reference, files, languageBuckets: languageBuckets(files), patchExcerpt: patch.slice(0, 4_000) };
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
  if (possibleReviewPrompt && isStandaloneReviewRequest(possibleReviewPrompt)) {
    const pullRequest = pullRequestUrl ?? pullRequestNumber;
    try {
      const result = pullRequest
        ? await pi.exec("gh", ["pr", "diff", pullRequest, "--patch"], { timeout: 10_000 })
        : await pi.exec("git", ["-C", cwd, "diff", "--no-ext-diff", "--unified=1", "HEAD", "--"], {
            timeout: 10_000,
          });
      if (result.code === 0 && result.stdout.trim()) {
        reviewDelta = parseReviewDelta(
          result.stdout,
          pullRequest ? "pull_request" : "working_tree",
          pullRequestUrl ?? (pullRequestNumber ? `PR #${pullRequestNumber}` : "HEAD to working tree/index"),
        );
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
