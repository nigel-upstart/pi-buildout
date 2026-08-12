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
 * Eligibility and the temporary endpoint-tier wrapper remain outside this comparator. A later layer
 * can therefore call it directly when tier-first routing is retired.
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
