import { complete, validateToolArguments } from "@earendil-works/pi-ai/compat";
import type { Api, Model, Tool } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_TOOL_NAME, classifyTask } from "./classifier.ts";
import type { ClassificationResult, ClassifierRequest, ClassifierTransport } from "./classifier.ts";
import { calculateEndpointEffectiveCost, compareEndpointEffectiveCost } from "./core/endpoint-cost.ts";
import type { EndpointEffectiveCostComparable } from "./core/endpoint-cost.ts";
import { TaskFeaturesSchema } from "./core/features.ts";
import { healthVerdict } from "./core/health.ts";
import type { ModelVendor } from "./core/profiles.ts";
import { providerWeightFor } from "./core/provider-weights.ts";
import type { RegistryModelSnapshot } from "./core/routing.ts";
import { canonicalModelId } from "./core/scope.ts";
import type { SessionSynopsis } from "./core/synopsis.ts";
import { requireToolCall } from "./core/tool-choice.ts";

const CLASSIFIER_TOOL: Tool = {
  name: CLASSIFIER_TOOL_NAME,
  description: "Return validated semantic task features. Never select a model or route.",
  parameters: TaskFeaturesSchema,
};

type ClassifierModel = {
  model: Pick<Model<Api>, "provider" | "id">;
  vendor: ModelVendor;
  endpointEffectiveCost?: number;
};

// Logical classifier tiers are resolved only against the operator's scoped registry snapshot.
// Luna remains preferred over Haiku regardless of endpoint cost; the shared endpoint comparator
// orders alternatives serving the same logical model. We do not guess an older Sonnet ID: an exact
// endpoint must canonicalize to one of these validated logical model IDs.
const PRIMARY_CLASSIFIER_TIERS = ["gpt-5.6-luna", "claude-haiku-4-5"] as const;

// The key is the primary tier's canonical vendor; each logical secondary tier deliberately belongs
// to a different vendor for independent reconciliation. Endpoint providers do not determine this:
// an Amazon Bedrock endpoint serving Sonnet is still an Anthropic secondary, for example.
const SECONDARY_CLASSIFIER_TIERS_BY_PRIMARY_VENDOR: Record<ModelVendor, readonly string[]> = {
  openai: ["claude-sonnet-5"],
  anthropic: ["gpt-5.6-terra"],
  google: ["gpt-5.6-terra"],
};

// Any thrown failure (rate limiting, transient 5xx, missing credentials, an unhealthy endpoint,
// etc.) falls through to the next endpoint candidate. An aborted request is the one exception:
// it means the caller cancelled the work, so retrying a different endpoint would be wasted and
// user-surprising work rather than resilience.
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function candidateLabel(candidate: ClassifierModel): string {
  return `${candidate.model.provider}/${candidate.model.id}`;
}

function comparable(candidate: ClassifierModel): EndpointEffectiveCostComparable {
  return {
    provider: candidate.model.provider,
    modelId: candidate.model.id,
    ...(candidate.endpointEffectiveCost === undefined
      ? {}
      : { endpointEffectiveCost: candidate.endpointEffectiveCost }),
  };
}

function resolveClassifierTier(registry: readonly RegistryModelSnapshot[], logicalModelId: string): ClassifierModel[] {
  const candidates: ClassifierModel[] = [];
  for (const endpoint of registry) {
    if (!endpoint.available || canonicalModelId(endpoint.modelId) !== logicalModelId) continue;
    if (!healthVerdict(endpoint.health).usable) continue;
    let endpointEffectiveCost: number | undefined;
    try {
      endpointEffectiveCost = calculateEndpointEffectiveCost(
        endpoint,
        (endpoint.providerWeight ?? providerWeightFor(endpoint.provider)).weight,
      );
    } catch (error) {
      if (error instanceof RangeError) continue;
      throw error;
    }
    candidates.push({
      model: { provider: endpoint.provider, id: endpoint.modelId },
      vendor: endpoint.vendor,
      ...(endpointEffectiveCost === undefined ? {} : { endpointEffectiveCost }),
    });
  }
  return candidates.sort((left, right) => compareEndpointEffectiveCost(comparable(left), comparable(right)));
}

function resolveClassifierTiers(
  registry: readonly RegistryModelSnapshot[],
  logicalModelIds: readonly string[],
): ClassifierModel[] {
  return logicalModelIds.flatMap((logicalModelId) => resolveClassifierTier(registry, logicalModelId));
}

export function selectClassifierModels(registry: readonly RegistryModelSnapshot[]): {
  primary: ClassifierModel[];
  secondary: ClassifierModel[];
} {
  const primary = resolveClassifierTiers(registry, PRIMARY_CLASSIFIER_TIERS);
  // The vendor guess only decides which independent secondary tier to search; tier order (Luna
  // before Haiku) means this reflects whichever logical tier has any eligible scoped endpoint.
  const primaryVendorGuess = primary[0]?.vendor;
  const secondary = primaryVendorGuess
    ? resolveClassifierTiers(registry, SECONDARY_CLASSIFIER_TIERS_BY_PRIMARY_VENDOR[primaryVendorGuess])
    : [];
  return { primary, secondary };
}

type CandidateCaller = (candidate: ClassifierModel, request: ClassifierRequest) => Promise<ClassifierTransportResult>;

type ClassifierTransportResult = Awaited<ReturnType<ClassifierTransport>>;

// Pure fallback iterator, deliberately decoupled from the network call so the failover behavior
// (try every candidate in order, stop on first success, only give up once the whole list is
// exhausted) is unit-testable without mocking the underlying provider SDKs.
export function transportFromCandidates(
  candidates: readonly ClassifierModel[],
  call: CandidateCaller,
): ClassifierTransport {
  return async (request) => {
    if (candidates.length === 0) {
      throw new Error(`No configured ${request.stage} classifier from the required vendor`);
    }
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        return await call(candidate, request);
      } catch (error) {
        if (isAbortError(error)) throw error;
        failures.push(`${candidateLabel(candidate)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All ${request.stage} classifier candidates failed: ${failures.join(" | ")}`);
  };
}

async function callClassifierModel(
  ctx: ExtensionContext,
  candidate: ClassifierModel,
  request: ClassifierRequest,
): Promise<ClassifierTransportResult> {
  const model = ctx.modelRegistry.find(candidate.model.provider, candidate.model.id);
  if (!model) throw new Error(`Classifier endpoint disappeared from registry: ${candidateLabel(candidate)}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error(`No request credential resolved for ${candidateLabel(candidate)}`);
  const started = performance.now();
  const response = await complete(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.userPrompt }],
          timestamp: Date.now(),
        },
      ],
      tools: [CLASSIFIER_TOOL],
    },
    {
      apiKey: auth.apiKey,
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(auth.env ? { env: auth.env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      maxTokens: 4_096,
      maxRetries: 1,
      reasoning: "low",
      onPayload: (payload) => requireToolCall(payload, model.api, CLASSIFIER_TOOL_NAME),
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Classifier stopped with ${response.stopReason}`);
  }
  const toolCall = response.content.find(
    (content) => content.type === "toolCall" && content.name === CLASSIFIER_TOOL_NAME,
  );
  if (toolCall?.type !== "toolCall") {
    throw new Error("Classifier did not return the required report_task_features tool call");
  }
  const validatedArguments: unknown = validateToolArguments(CLASSIFIER_TOOL, toolCall);
  return {
    arguments: validatedArguments,
    provider: candidate.model.provider,
    modelId: candidate.model.id,
    vendor: candidate.vendor,
    latencyMs: Math.round(performance.now() - started),
    usage: {
      input: response.usage.input,
      output: response.usage.output,
      cacheRead: response.usage.cacheRead,
      cacheWrite: response.usage.cacheWrite,
      cost: response.usage.cost.total,
    },
  };
}

function transportFor(ctx: ExtensionContext, candidates: readonly ClassifierModel[]): ClassifierTransport {
  return transportFromCandidates(candidates, (candidate, request) => callClassifierModel(ctx, candidate, request));
}

export async function classifyTaskWithPi(input: {
  ctx: ExtensionContext;
  registry: readonly RegistryModelSnapshot[];
  prompt: string;
  synopsis: SessionSynopsis;
  signal?: AbortSignal;
}): Promise<ClassificationResult> {
  const selected = selectClassifierModels(input.registry);
  const primaryVendor = selected.primary[0]?.vendor;
  const secondaryVendor = selected.secondary[0]?.vendor;
  return classifyTask({
    prompt: input.prompt,
    synopsis: input.synopsis,
    primary: transportFor(input.ctx, selected.primary),
    secondary: transportFor(input.ctx, selected.secondary),
    ...(primaryVendor ? { primaryVendor } : {}),
    ...(secondaryVendor ? { secondaryVendor } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
