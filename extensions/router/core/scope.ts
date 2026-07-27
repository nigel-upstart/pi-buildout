import type { EndpointTier } from "./policy.ts";

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

/** Vendor path segment used by resale catalogs, e.g. `anthropic.claude-sonnet-5`. */
const VENDOR_PATH_PREFIX =
  /^(?:anthropic|openai|google|meta|amazon|mistral|deepseek|qwen|ai21|cohere|writer|stability|twelvelabs)\./;

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
  let bare = modelId.split("/").at(-1) ?? modelId;
  bare = bare.replace(BEDROCK_REGION_PREFIX, "").replace(VENDOR_PATH_PREFIX, "");
  bare = bare.replace(VERSION_SUFFIX, "").replace(DATE_SUFFIX, "");
  if (bare.startsWith("claude-")) bare = bare.replace(/(\d)\.(\d)/g, "$1-$2");
  return bare;
}

/**
 * Endpoint preference tier for a provider. The manufacturer's own route is preferred, a gateway we
 * operate comes next, and a resale catalog last. Unknown providers are treated as resale rather than
 * promoted, so adding a provider cannot silently outrank a first-party route.
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
 * Within one provider, prefer the plainest spelling of a model. Bedrock exposes the same model as a
 * bare ID and as several region profiles; a dated or versioned ID is the least preferred because it
 * pins a specific release.
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
