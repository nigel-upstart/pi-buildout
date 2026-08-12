import {
  blendedEndpointCost,
  calculateEndpointEffectiveCost,
  classifyCacheWriteRate,
  compareEndpointEffectiveCost,
} from "./endpoint-cost.ts";
import type { CacheWriteClassification } from "./endpoint-cost.ts";
import { healthVerdict } from "./health.ts";
import { providerWeightFor } from "./provider-weights.ts";
import type { ProviderWeightBasis, ProviderWeightRejection, ProviderWeightSource } from "./provider-weights.ts";
import type { CandidateExclusion, RegistryModelSnapshot } from "./routing.ts";
import { canonicalModelId, isFlatRateProvider, matchesScope } from "./scope.ts";
import type { ScopePatternSource } from "./scope.ts";

/** Same bounded diagnostic payload size used for the router's session synopsis. */
export const MAX_ROUTE_SCOPE_BYTES = 8_000;

type RegistryIdentity = {
  provider: string;
  modelId: string;
};

type ScopeEndpointDiagnostic = {
  provider: string;
  modelId: string;
  listCost?: number;
  appliedWeight?: number;
  weightBasis?: ProviderWeightBasis;
  weightSource?: ProviderWeightSource;
  cacheWriteClassification?: CacheWriteClassification;
  effectiveCost?: number;
};

type ScopeLogicalModelDiagnostic = {
  logicalModelId: string;
  endpoints: ScopeEndpointDiagnostic[];
};

type ScopeDiagnosticExclusion = CandidateExclusion & {
  source: "scope" | "latest-route";
};

export type ScopeDiagnostics = {
  patterns: readonly string[];
  patternSource: ScopePatternSource;
  unmatchedPatterns: readonly string[];
  logicalModels: ScopeLogicalModelDiagnostic[];
  exclusions: ScopeDiagnosticExclusion[];
  providerWeightRejections: readonly ProviderWeightRejection[];
};

function endpointKey(endpoint: Pick<RegistryIdentity, "provider" | "modelId">): string {
  return `${endpoint.provider}/${endpoint.modelId}`;
}

function diagnosticForEndpoint(
  model: RegistryModelSnapshot,
  exclusions: ScopeDiagnosticExclusion[],
): ScopeEndpointDiagnostic | undefined {
  const candidate = endpointKey(model);
  if (!model.available) {
    exclusions.push({
      source: "scope",
      candidate,
      code: "unavailable",
      detail: "endpoint auth/availability is not configured",
    });
    return undefined;
  }
  const health = healthVerdict(model.health);
  if (!health.usable) {
    exclusions.push({ source: "scope", candidate, code: "endpoint_unhealthy", detail: health.reason });
    return undefined;
  }

  let cacheWriteClassification: CacheWriteClassification | undefined;
  try {
    cacheWriteClassification = classifyCacheWriteRate(model.costPerMillion);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Cache rates are diagnostic metadata, not an input to route eligibility or endpoint ordering.
  }
  if (isFlatRateProvider(model.provider)) {
    return {
      provider: model.provider,
      modelId: model.modelId,
      ...(cacheWriteClassification ? { cacheWriteClassification } : {}),
    };
  }

  try {
    const weight = model.providerWeight ?? providerWeightFor(model.provider);
    const effectiveCost = calculateEndpointEffectiveCost(model, weight.weight);
    if (effectiveCost === undefined) throw new RangeError("token-billed endpoint has no effective cost");
    return {
      provider: model.provider,
      modelId: model.modelId,
      listCost: blendedEndpointCost(model),
      appliedWeight: weight.weight,
      weightBasis: weight.basis,
      weightSource: weight.source,
      ...(cacheWriteClassification ? { cacheWriteClassification } : {}),
      effectiveCost,
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    exclusions.push({ source: "scope", candidate, code: "endpoint_pricing_invalid", detail: error.message });
    return undefined;
  }
}

/**
 * Builds a behavior-neutral view of the scoped registry. Endpoint eligibility here is limited to
 * scope-wide facts (availability, persisted health, and valid pricing); task-specific exclusions are
 * carried from the latest route decision rather than guessed without an archetype or requirements.
 */
export function buildScopeDiagnostics(input: {
  patterns: readonly string[];
  patternSource: ScopePatternSource;
  registry: readonly RegistryModelSnapshot[];
  allRegistryEndpoints: readonly RegistryIdentity[];
  providerWeightRejections: readonly ProviderWeightRejection[];
  latestRouteExclusions?: readonly CandidateExclusion[];
}): ScopeDiagnostics {
  const exclusions: ScopeDiagnosticExclusion[] = [];
  const groups = new Map<string, ScopeEndpointDiagnostic[]>();
  for (const model of input.registry) {
    const logicalModelId = canonicalModelId(model.modelId);
    if (!groups.has(logicalModelId)) groups.set(logicalModelId, []);
    const diagnostic = diagnosticForEndpoint(model, exclusions);
    if (diagnostic) groups.get(logicalModelId)?.push(diagnostic);
  }

  const logicalModels = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([logicalModelId, endpoints]) => ({
      logicalModelId,
      endpoints: endpoints.sort((left, right) =>
        compareEndpointEffectiveCost(
          {
            provider: left.provider,
            modelId: left.modelId,
            ...(left.effectiveCost === undefined ? {} : { endpointEffectiveCost: left.effectiveCost }),
          },
          {
            provider: right.provider,
            modelId: right.modelId,
            ...(right.effectiveCost === undefined ? {} : { endpointEffectiveCost: right.effectiveCost }),
          },
        ),
      ),
    }));
  const unmatchedPatterns = input.patterns.filter(
    (pattern) =>
      !input.allRegistryEndpoints.some((endpoint) => matchesScope(endpoint.provider, endpoint.modelId, [pattern])),
  );
  exclusions.push(
    ...(input.latestRouteExclusions ?? []).map((exclusion) => ({ ...exclusion, source: "latest-route" as const })),
  );
  return {
    patterns: input.patterns,
    patternSource: input.patternSource,
    unmatchedPatterns,
    logicalModels,
    exclusions,
    providerWeightRejections: input.providerWeightRejections,
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cost(value: number | undefined, flatRate: boolean): string {
  if (value !== undefined) return value.toFixed(6);
  return flatRate ? "n/a(flat-rate)" : "n/a";
}

function scopeDiagnosticLines(diagnostics: ScopeDiagnostics): string[] {
  const lines = ["route scope", `patterns (${String(diagnostics.patterns.length)}):`];
  if (diagnostics.patterns.length === 0) {
    lines.push(`  - source=${diagnostics.patternSource} pattern=<all registry models>`);
  } else {
    for (const pattern of diagnostics.patterns) {
      lines.push(`  - source=${diagnostics.patternSource} pattern=${singleLine(pattern)}`);
    }
  }

  lines.push(`unmatched patterns (${String(diagnostics.unmatchedPatterns.length)}):`);
  for (const pattern of diagnostics.unmatchedPatterns) {
    lines.push(`  - source=${diagnostics.patternSource} pattern=${singleLine(pattern)}`);
  }

  lines.push(`logical models (${String(diagnostics.logicalModels.length)}):`);
  for (const logical of diagnostics.logicalModels) {
    lines.push(`  ${logical.logicalModelId} (${String(logical.endpoints.length)} eligible endpoints):`);
    for (const [index, endpoint] of logical.endpoints.entries()) {
      const flatRate = isFlatRateProvider(endpoint.provider);
      lines.push(
        `    ${String(index + 1)}. endpoint=${endpointKey(endpoint)} listCost=${cost(endpoint.listCost, flatRate)} appliedWeight=${cost(endpoint.appliedWeight, flatRate)} weightBasis=${endpoint.weightBasis ?? "n/a"} weightSource=${endpoint.weightSource ?? "n/a"} cacheWrite=${endpoint.cacheWriteClassification ?? "n/a"} effectiveCost=${cost(endpoint.effectiveCost, flatRate)}`,
      );
    }
  }

  lines.push(`excluded endpoints (${String(diagnostics.exclusions.length)}):`);
  for (const exclusion of diagnostics.exclusions) {
    lines.push(
      `  - source=${exclusion.source} candidate=${singleLine(exclusion.candidate)} code=${exclusion.code} detail=${singleLine(exclusion.detail)}`,
    );
  }

  lines.push(`provider-weight rejections (${String(diagnostics.providerWeightRejections.length)}):`);
  for (const rejection of diagnostics.providerWeightRejections) {
    lines.push(
      `  - provider=${singleLine(rejection.provider ?? "<map>")} source=${rejection.source} reason=${singleLine(rejection.reason)}`,
    );
  }
  return lines;
}

/** Renders complete lines up to a hard UTF-8 byte budget and states exactly how much was omitted. */
export function renderScopeDiagnostics(diagnostics: ScopeDiagnostics, byteBudget = MAX_ROUTE_SCOPE_BYTES): string {
  const lines = scopeDiagnosticLines(diagnostics);
  const complete = lines.join("\n");
  if (Buffer.byteLength(complete, "utf8") <= byteBudget) return complete;

  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const omitted = lines.length - index - 1;
    const marker = `... truncated: ${String(omitted)} additional lines omitted (${String(byteBudget)}-byte budget)`;
    const candidate = [...kept, lines[index] ?? "", marker].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > byteBudget) break;
    kept.push(lines[index] ?? "");
  }
  const omitted = lines.length - kept.length;
  const marker = `... truncated: ${String(omitted)} additional lines omitted (${String(byteBudget)}-byte budget)`;
  while (kept.length > 0 && Buffer.byteLength([...kept, marker].join("\n"), "utf8") > byteBudget) kept.pop();
  if (Buffer.byteLength(marker, "utf8") > byteBudget) return "";
  return [...kept, marker].join("\n");
}
