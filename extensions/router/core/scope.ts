import type { EndpointTier } from "./policy.ts";

export type ScopePatternSource = "environment" | "project" | "user" | "default";

/**
 * Endpoint identity and scope resolution.
 *
 * The router's candidate pool is derived from the models the operator has actually scoped in — the
 * `enabledModels` patterns that drive pi's model selector — intersected with the live registry. It is
 * not a hand-maintained provider table, because such a table drifts from the machine it runs on: it
 * names endpoints the operator never enabled, and misses the ones they did.
 *
 * Policy therefore declares a *logical model* plus an effort, and this module answers which concrete
 * endpoints serve that model here.
 */

/** Amazon Bedrock cross-region inference-profile prefixes. */
const BEDROCK_REGION_PREFIX = /^(?:us|eu|au|jp|apac|global)\./;

/**
 * Vendor path segments that resale catalogs prefix onto a model ID, e.g. `anthropic.claude-sonnet-5`
 * or `zai.glm-5`, and that may be dropped because what remains still identifies the model.
 *
 * Membership is a claim about the vendor's naming, not a list of vendors we like. Dropping a segment
 * is only correct when the remainder self-identifies: `zai.glm-5` reduces to `glm-5`,
 * `minimax.minimax-m2.5` to `minimax-m2.5`, `nvidia.nemotron-super-3-120b` to
 * `nemotron-super-3-120b`. A vendor whose catalog names omit the brand belongs in
 * VENDOR_PATH_REWRITE instead.
 */
const VENDOR_PATH_SEGMENTS = new Set([
  "anthropic",
  "openai",
  "google",
  "meta",
  "amazon",
  "mistral",
  "qwen",
  "ai21",
  "cohere",
  "writer",
  "stability",
  "twelvelabs",
  "minimax",
  "moonshot",
  "moonshotai",
  "nvidia",
  "xai",
  "zai",
]);

/**
 * Vendor path segments that carry part of the model's identity and are rewritten rather than
 * dropped.
 *
 * DeepSeek's catalog names are `v3.2`, `v3` and `r1`, with no brand token. Dropping the segment
 * reduces `deepseek.v3.2` to a bare `v3.2`, which identifies no vendor and collides with any other
 * catalog's `v3.2`, and reduces `us.deepseek.r1-v1:0` to a bare `r1` once the version suffix is also
 * removed. Both were live defects: the resulting IDs matched no policy candidate and could have
 * grouped unrelated endpoints together.
 */
const VENDOR_PATH_REWRITE = new Map([["deepseek", "deepseek-"]]);

/** Bedrock model-version suffixes: `-v1`, `-v1:0`, `-1:0`, `:0`. */
const VERSION_SUFFIX = /(?:-v\d+(?::\d+)?|-\d+:\d+|:\d+)$/;

/** Dated release stamp, e.g. `claude-haiku-4-5-20251001`. */
const DATE_SUFFIX = /-\d{8}$/;

/**
 * Reduces a provider-specific endpoint ID to the manufacturer's logical model ID, which is what the
 * evidence priors, effort policies, ability bands, and prompt profiles are keyed by.
 *
 * Claude IDs are normalized to the dashed form the Anthropic catalog uses, because resale catalogs
 * spell the same model with dots (`claude-opus-4.7`). GPT and Gemini IDs keep their dots, which is
 * the form their own catalogs use.
 */
export function canonicalModelId(modelId: string): string {
  // A gateway path such as `bedrock/anthropic.claude-sonnet-5` carries the real ID in its last segment.
  //
  // Case is folded because catalogs disagree on it for the same model: Bedrock spells Z.ai's model
  // `zai.glm-5` while the Hugging Face and Together catalogs spell it `zai-org/GLM-5`, and the same
  // split affects Kimi, MiniMax, Qwen and DeepSeek entries. Folding is safe rather than merely
  // convenient: across all 1,065 entries of the pinned registry no two IDs within one provider differ
  // only by case, and every incumbent ID is already lower-case, so no incumbent identity moves.
  let bare = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
  bare = normalizeVendorPath(bare.replace(BEDROCK_REGION_PREFIX, ""));
  bare = bare.replace(VERSION_SUFFIX, "").replace(DATE_SUFFIX, "");
  if (bare.startsWith("claude-")) bare = bare.replace(/(\d)\.(\d)/g, "$1-$2");
  return bare;
}

/**
 * Resolves the leading vendor path segment, if there is one.
 *
 * Exact segment equality is deliberate. A prefix regex over the same names would misparse dotted
 * model IDs whose first dot falls inside the model name: `gpt-5.6-terra` has a leading segment of
 * `gpt-5`, `gemini-3.5-flash` has `gemini-3`, and `claude-opus-4.7` has `claude-opus-4`. None is a
 * vendor, so all three are returned untouched and their own catalogs' dotted spelling survives.
 */
function normalizeVendorPath(modelId: string): string {
  const separator = modelId.indexOf(".");
  if (separator <= 0) return modelId;
  const segment = modelId.slice(0, separator);
  const remainder = modelId.slice(separator + 1);
  const rewrite = VENDOR_PATH_REWRITE.get(segment);
  if (rewrite !== undefined) return `${rewrite}${remainder}`;
  return VENDOR_PATH_SEGMENTS.has(segment) ? remainder : modelId;
}

/**
 * Diagnostic endpoint classification retained in persisted leases and scope tests. It records the
 * provider relationship but does not influence endpoint ordering; unknown providers remain labelled
 * as resale metadata.
 */
const PROVIDER_TIERS: Readonly<Record<string, EndpointTier>> = {
  anthropic: "manufacturer",
  openai: "manufacturer",
  "openai-codex": "manufacturer",
  google: "manufacturer",
  "google-vertex": "manufacturer",
  bifrost: "gateway",
  "amazon-bedrock": "resale",
  "github-copilot": "resale",
};

export function endpointTierFor(provider: string): EndpointTier {
  return PROVIDER_TIERS[provider] ?? "resale";
}

/** Providers that bill per seat or per request rather than per token. */
const FLAT_RATE_PROVIDERS = new Set(["github-copilot"]);

export function isFlatRateProvider(provider: string): boolean {
  return FLAT_RATE_PROVIDERS.has(provider);
}

/**
 * Deterministic tie-break for equal-effective-cost endpoints. Prefer the plainest spelling of a
 * model; a dated or versioned ID is least specific because it pins a particular release.
 */
export function endpointSpecificity(modelId: string): number {
  let score = 0;
  // A cross-region "global." profile is preferred over a single region, because the cost analysis
  // favors Global profiles for the traffic that stays on a resale route. Data residency would invert
  // this, so an operator with a residency constraint should scope the regional profile in and leave
  // the global one out rather than rely on ordering.
  if (modelId.startsWith("global.")) score += 1;
  else if (BEDROCK_REGION_PREFIX.test(modelId)) score += 2;
  if (VERSION_SUFFIX.test(modelId)) score += 4;
  if (DATE_SUFFIX.test(modelId.replace(VERSION_SUFFIX, ""))) score += 8;
  return score;
}

/**
 * Scope patterns follow pi's `enabledModels` and `--models` semantics for the forms this router
 * needs: an exact `provider/id`, a bare `id`, and `*` globs, each with an optional `:level` suffix
 * that is ignored here because effort is a routing decision rather than an identity.
 *
 * An empty pattern list means "no scope configured", which is treated as "everything available is in
 * scope" — the same thing pi does when `enabledModels` is absent.
 */
export function matchesScope(provider: string, modelId: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  const reference = `${provider}/${modelId}`;
  return patterns.some((rawPattern) => {
    const pattern = stripThinkingSuffix(rawPattern.trim());
    if (pattern === "") return false;
    if (pattern.includes("*")) return globMatches(pattern, reference) || globMatches(pattern, modelId);
    return pattern === reference || pattern === modelId;
  });
}

/**
 * A trailing `:level` is an effort request, not part of the identity. Bedrock IDs legitimately end in
 * `:0`, so only a known thinking level is stripped.
 */
function stripThinkingSuffix(pattern: string): string {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const index = pattern.lastIndexOf(":");
  if (index <= 0) return pattern;
  return levels.includes(pattern.slice(index + 1)) ? pattern.slice(0, index) : pattern;
}

/**
 * Literal `*` glob matching without building a RegExp from input. Segments must appear in order; the
 * first must anchor the start and the last must anchor the end unless the pattern begins or ends with
 * a wildcard.
 */
function globMatches(pattern: string, value: string): boolean {
  const segments = pattern.split("*");
  const first = segments[0] ?? "";
  const last = segments.at(-1) ?? "";
  if (!value.startsWith(first)) return false;
  if (!value.endsWith(last)) return false;
  let cursor = first.length;
  for (const segment of segments.slice(1, -1)) {
    if (segment === "") continue;
    const found = value.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }
  return cursor <= value.length - last.length || segments.length === 1;
}
