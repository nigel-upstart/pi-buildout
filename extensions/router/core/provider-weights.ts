export const ROUTER_PROVIDER_WEIGHTS_ENV = "PI_ROUTER_PROVIDER_WEIGHTS";
const ROUTER_PROVIDER_WEIGHTS_SETTING = "routerProviderWeights";

export const PROVIDER_WEIGHT_MIN = 0.5;
export const PROVIDER_WEIGHT_MAX = 2.0;
export const PROVIDER_WEIGHT_REJECTION_LIMIT = 100;
const REJECTION_PROVIDER_MAX_LENGTH = 160;

type ProviderWeightBasis = "contract" | "preference";
type ProviderWeightSource = "environment" | "project" | "user" | "built-in" | "rejection-fallback";
type ConfiguredProviderWeightSource = Extract<ProviderWeightSource, "environment" | "project" | "user">;

export type ResolvedProviderWeight = {
  weight: number;
  basis: ProviderWeightBasis;
  source: ProviderWeightSource;
};

export type ProviderWeightRejection = {
  /** Absent when the whole environment value or settings map was malformed. */
  provider?: string;
  source: ConfiguredProviderWeightSource;
  /** A non-sensitive summary; rejected configuration values are never retained. */
  rejectedValueType: string;
  reason: string;
};

export type ProviderWeightResolution = {
  weights: ReadonlyMap<string, ResolvedProviderWeight>;
  rejections: readonly ProviderWeightRejection[];
};

type ObjectLike = Record<string, unknown>;
type ConfiguredMap = { source: ConfiguredProviderWeightSource; value: ObjectLike };

const BUILT_IN_PROVIDER_WEIGHTS = new Map<string, Omit<ResolvedProviderWeight, "source">>([
  ["amazon-bedrock", { weight: 0.83, basis: "contract" }],
  ["openai-codex", { weight: 1.0, basis: "preference" }],
  ["anthropic", { weight: 1.0, basis: "preference" }],
  ["google", { weight: 1.0, basis: "preference" }],
  ["google-vertex", { weight: 1.0, basis: "preference" }],
  ["bifrost", { weight: 1.0, basis: "preference" }],
  ["openai", { weight: 1.001, basis: "preference" }],
]);

const UNKNOWN_PROVIDER_WEIGHT: Omit<ResolvedProviderWeight, "source"> = {
  weight: 1.01,
  basis: "preference",
};

function object(value: unknown): ObjectLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectLike) : undefined;
}

/** Reads only a data property's own descriptor, without invoking accessors or reaching a prototype. */
export function ownProperty(source: ObjectLike | undefined, key: string): unknown {
  return source ? Object.getOwnPropertyDescriptor(source, key)?.value : undefined;
}

function hasOwnProperty(source: ObjectLike, key: string): boolean {
  return Object.getOwnPropertyDescriptor(source, key) !== undefined;
}

function rejectedValueType(value: unknown): string {
  if (value === null) return "null";
  try {
    if (Array.isArray(value)) return "array";
  } catch {
    return "uninspectable";
  }
  return typeof value;
}

function boundedProvider(provider: string): string {
  if (provider.length <= REJECTION_PROVIDER_MAX_LENGTH) return provider;
  return `${provider.slice(0, REJECTION_PROVIDER_MAX_LENGTH - 3)}...`;
}

function recordRejection(
  rejections: ProviderWeightRejection[],
  rejection: {
    provider?: string;
    source: ConfiguredProviderWeightSource;
    rejectedValue: unknown;
    reason: string;
  },
): void {
  if (rejections.length >= PROVIDER_WEIGHT_REJECTION_LIMIT) return;
  rejections.push({
    ...(rejection.provider === undefined ? {} : { provider: boundedProvider(rejection.provider) }),
    source: rejection.source,
    rejectedValueType: rejectedValueType(rejection.rejectedValue),
    reason: rejection.reason,
  });
}

function rejectMap(
  rejections: ProviderWeightRejection[],
  source: ConfiguredProviderWeightSource,
  rejectedValue: unknown,
): void {
  recordRejection(rejections, {
    source,
    rejectedValue,
    reason: "provider weights must be a JSON object keyed by provider",
  });
}

function settingsMap(
  settings: unknown,
  source: "project" | "user",
  rejections: ProviderWeightRejection[],
): ConfiguredMap | undefined {
  const settingsObject = object(settings);
  if (!settingsObject || !hasOwnProperty(settingsObject, ROUTER_PROVIDER_WEIGHTS_SETTING)) return undefined;
  const configured = ownProperty(settingsObject, ROUTER_PROVIDER_WEIGHTS_SETTING);
  const configuredObject = object(configured);
  if (configuredObject) return { source, value: configuredObject };
  rejectMap(rejections, source, configured);
  return undefined;
}

function environmentMap(value: string | undefined, rejections: ProviderWeightRejection[]): ConfiguredMap | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    recordRejection(rejections, {
      source: "environment",
      rejectedValue: value,
      reason: `${ROUTER_PROVIDER_WEIGHTS_ENV} must contain valid JSON`,
    });
    return undefined;
  }
  const parsedObject = object(parsed);
  if (parsedObject) return { source: "environment", value: parsedObject };
  rejectMap(rejections, "environment", parsed);
  return undefined;
}

function validateConfiguredWeight(value: unknown): Omit<ResolvedProviderWeight, "source"> | string {
  let weight: unknown;
  let basis: unknown = "preference";
  if (typeof value === "number") {
    weight = value;
  } else {
    const entry = object(value);
    if (!entry || !hasOwnProperty(entry, "weight") || !hasOwnProperty(entry, "basis")) {
      return "entry must be a number or an object with own weight and basis properties";
    }
    weight = ownProperty(entry, "weight");
    basis = ownProperty(entry, "basis");
  }
  if (typeof weight !== "number" || !Number.isFinite(weight)) return "weight must be a finite number";
  if (weight < PROVIDER_WEIGHT_MIN || weight > PROVIDER_WEIGHT_MAX) {
    return `weight must be between ${String(PROVIDER_WEIGHT_MIN)} and ${String(PROVIDER_WEIGHT_MAX)} inclusive`;
  }
  if (basis !== "contract" && basis !== "preference") {
    return "basis must be 'contract' or 'preference'";
  }
  return { weight, basis };
}

/**
 * Resolves each provider independently. An invalid highest-precedence entry is an explicit neutral
 * fallback, not permission to recover a lower-precedence discount for that provider.
 */
export function resolveProviderWeights(
  input: {
    environmentValue?: string | undefined;
    projectSettings?: unknown;
    userSettings?: unknown;
  } = {},
): ProviderWeightResolution {
  const rejections: ProviderWeightRejection[] = [];
  const configuredMaps = [
    environmentMap(input.environmentValue, rejections),
    settingsMap(input.projectSettings, "project", rejections),
    settingsMap(input.userSettings, "user", rejections),
  ].filter((configured): configured is ConfiguredMap => configured !== undefined);

  const providers = new Set(BUILT_IN_PROVIDER_WEIGHTS.keys());
  for (const configured of configuredMaps) {
    for (const provider of Object.getOwnPropertyNames(configured.value)) providers.add(provider);
  }

  const weights = new Map<string, ResolvedProviderWeight>();
  for (const provider of providers) {
    const selected = configuredMaps.find((configured) => hasOwnProperty(configured.value, provider));
    if (selected) {
      const rejectedValue = ownProperty(selected.value, provider);
      const validated = validateConfiguredWeight(rejectedValue);
      if (typeof validated === "string") {
        recordRejection(rejections, { provider, source: selected.source, rejectedValue, reason: validated });
        weights.set(provider, { weight: 1.0, basis: "preference", source: "rejection-fallback" });
      } else {
        weights.set(provider, { ...validated, source: selected.source });
      }
      continue;
    }
    const builtIn = BUILT_IN_PROVIDER_WEIGHTS.get(provider);
    if (builtIn) weights.set(provider, { ...builtIn, source: "built-in" });
  }
  return { weights, rejections };
}

/** Resolves providers that were not present in configuration through the conservative unknown default. */
export function providerWeightFor(
  provider: string,
  weights?: ReadonlyMap<string, ResolvedProviderWeight>,
): ResolvedProviderWeight {
  const configured = weights?.get(provider);
  if (configured) return { ...configured };
  const builtIn = BUILT_IN_PROVIDER_WEIGHTS.get(provider);
  return builtIn ? { ...builtIn, source: "built-in" } : { ...UNKNOWN_PROVIDER_WEIGHT, source: "built-in" };
}
