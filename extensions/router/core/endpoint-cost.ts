import { endpointSpecificity, isFlatRateProvider } from "./scope.ts";

export type CacheWriteClassification = "priced_write" | "no_write_line_item" | "caching_unpriced";

type CacheRates = {
  cacheRead: number;
  cacheWrite: number;
};

type EndpointPrice = {
  provider: string;
  costPerMillion: {
    input: number;
    output: number;
  };
};

/** Full rate vector, needed by the reference-mix cost because cache classes differ across vendors. */
type EndpointRates = {
  provider: string;
  costPerMillion: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

/**
 * Observed 30-day Amazon Bedrock token mix, from CloudZero authenticated cost data. Recorded in
 * specs/routing-layer/scoped-model-analysis-2026-08-13.md.
 *
 * This is an estimate of the operator's realized traffic shape, not a property of any endpoint. It
 * exists so a diagnostic can price an endpoint the way it is actually billed, which the fixed blend
 * below deliberately does not attempt.
 */
const REFERENCE_TOKEN_MIX = Object.freeze({
  input: 0.7368,
  output: 0.1442,
  cacheRead: 0.1061,
  cacheWrite: 0.0129,
});

/**
 * Cache-read share among the tokens `referenceMixEndpointCost` treats as input-side.
 *
 * The denominator deliberately excludes `cacheWrite`, matching the `inputSide` split below, so that
 * `inputSide * REFERENCE_CACHE_READ_SHARE` reproduces the observed `cacheRead` share of 0.1061
 * exactly. Dividing by the write share as well yields 0.1240 and reconstructs only 0.1045, which
 * would understate cache benefit for every cache-priced endpoint.
 */
const REFERENCE_CACHE_READ_SHARE =
  REFERENCE_TOKEN_MIX.cacheRead / (REFERENCE_TOKEN_MIX.input + REFERENCE_TOKEN_MIX.cacheRead);

export type EndpointEffectiveCostComparable = {
  provider: string;
  modelId: string;
  /** Absent when token prices are not billed costs, such as a flat-rate subscription endpoint. */
  endpointEffectiveCost?: number;
};

function finiteNonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and nonnegative`);
  }
  return value;
}

/**
 * Makes the registry's required zero cache-write rate explicit instead of overloading a bare zero.
 * A positive read rate proves that caching is priced even when there is no separate write line item.
 */
export function classifyCacheWriteRate(rates: CacheRates): CacheWriteClassification {
  const cacheRead = finiteNonnegative(rates.cacheRead, "cacheRead");
  const cacheWrite = finiteNonnegative(rates.cacheWrite, "cacheWrite");
  if (cacheWrite > 0) return "priced_write";
  return cacheRead > 0 ? "no_write_line_item" : "caching_unpriced";
}

/** Output-weighted list-price blend for endpoints serving the same logical model and effort. */
export function blendedEndpointCost(endpoint: EndpointPrice): number {
  const input = finiteNonnegative(endpoint.costPerMillion.input, "input price");
  const output = finiteNonnegative(endpoint.costPerMillion.output, "output price");
  return 0.25 * input + 0.75 * output;
}

/**
 * Reference-mix effective price per million tokens: what an endpoint costs under the operator's
 * observed traffic shape rather than under a fixed 25/75 split.
 *
 * This exists because `blendedEndpointCost` is cache-blind, and its order-preservation argument holds
 * only for endpoints of the SAME logical model whose exact rate vectors match. No scoped-versus-
 * incumbent comparison satisfies that condition: every scoped Bedrock endpoint except `xai.grok-4.3`
 * prices no cache at all, while every Anthropic and GPT-5.6 Bedrock endpoint does.
 *
 * `caching_unpriced` is billed honestly rather than favourably. A zero cache rate means caching is
 * unpriced or unsupported, so those input-side tokens are not free — they are charged at the input
 * rate. Treating the registry's zero as a discount would make an endpoint that cannot cache look
 * cheaper than one that can, which is backwards.
 *
 * `cacheReadShare` is the share of input-side tokens served from cache. It is a property of the
 * workload, not the endpoint: a lease-preserving router reusing K/V cache sits well above the estate
 * figure, so callers should pass a measured share where one exists rather than rely on the default.
 */
export function referenceMixEndpointCost(
  endpoint: EndpointRates,
  cacheReadShare: number = REFERENCE_CACHE_READ_SHARE,
): number {
  const input = finiteNonnegative(endpoint.costPerMillion.input, "input price");
  const output = finiteNonnegative(endpoint.costPerMillion.output, "output price");
  const cacheRead = finiteNonnegative(endpoint.costPerMillion.cacheRead, "cacheRead price");
  const cacheWrite = finiteNonnegative(endpoint.costPerMillion.cacheWrite, "cacheWrite price");
  const share = finiteNonnegative(cacheReadShare, "cache-read share");
  if (share > 1) throw new RangeError("cache-read share must not exceed 1");

  const outputShare = REFERENCE_TOKEN_MIX.output;
  const writeShare = REFERENCE_TOKEN_MIX.cacheWrite;
  const inputSide = 1 - outputShare - writeShare;
  const readShare = inputSide * share;
  const freshShare = inputSide - readShare;

  if (classifyCacheWriteRate(endpoint.costPerMillion) === "caching_unpriced") {
    return (freshShare + readShare + writeShare) * input + outputShare * output;
  }
  return freshShare * input + readShare * cacheRead + writeShare * cacheWrite + outputShare * output;
}

/**
 * How many times more tokens `candidate` may consume than `incumbent`, at equal quality, before it
 * costs the same. Below 1 the candidate is already more expensive per token.
 *
 * The same device the policy uses elsewhere for turn-count break-even, applied to rates. It is a
 * diagnostic: nothing here decides a route, because equal quality is an assumption the caller makes
 * and not something these rates can establish.
 */
export function breakEvenTokenMultiplier(
  incumbent: { rates: EndpointRates; weight: number },
  candidate: { rates: EndpointRates; weight: number },
  cacheReadShare: number = REFERENCE_CACHE_READ_SHARE,
): number {
  const candidateCost =
    referenceMixEndpointCost(candidate.rates, cacheReadShare) * finiteNonnegative(candidate.weight, "candidate weight");
  if (candidateCost === 0) return Number.POSITIVE_INFINITY;
  return (
    (referenceMixEndpointCost(incumbent.rates, cacheReadShare) *
      finiteNonnegative(incumbent.weight, "incumbent weight")) /
    candidateCost
  );
}

/**
 * Computes the token-billed ordering value. The caller supplies its already validated provider
 * weight explicitly; flat-rate capability proxies remain excluded regardless of nominal weight.
 */
export function calculateEndpointEffectiveCost(endpoint: EndpointPrice, providerWeight: number): number | undefined {
  if (isFlatRateProvider(endpoint.provider)) return undefined;
  return finiteNonnegative(
    blendedEndpointCost(endpoint) * finiteNonnegative(providerWeight, "provider weight"),
    "endpoint effective cost",
  );
}

function compareCodePointText(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  for (;;) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done === rightPoint.done) return 0;
      return leftPoint.done ? -1 : 1;
    }
    const difference = (leftPoint.value.codePointAt(0) ?? 0) - (rightPoint.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
}

/**
 * Deterministic total order for concrete endpoints: token-billed effective cost, model-ID
 * specificity, then the exact provider/model identity. Flat-rate endpoints have no effective cost
 * and sort after every token-billed endpoint.
 *
 * Callers filter eligibility and validate pricing before comparison. Endpoint tiers are diagnostic
 * metadata only and deliberately remain outside this comparator.
 */
export function compareEndpointEffectiveCost(
  left: EndpointEffectiveCostComparable,
  right: EndpointEffectiveCostComparable,
): number {
  const leftFlat = left.endpointEffectiveCost === undefined;
  const rightFlat = right.endpointEffectiveCost === undefined;
  if (leftFlat !== rightFlat) return leftFlat ? 1 : -1;
  if (!leftFlat && !rightFlat) {
    const cost =
      finiteNonnegative(left.endpointEffectiveCost ?? 0, "endpoint effective cost") -
      finiteNonnegative(right.endpointEffectiveCost ?? 0, "endpoint effective cost");
    if (cost !== 0) return cost;
  }
  const specificity = endpointSpecificity(left.modelId) - endpointSpecificity(right.modelId);
  if (specificity !== 0) return specificity;
  return compareCodePointText(`${left.provider}/${left.modelId}`, `${right.provider}/${right.modelId}`);
}
