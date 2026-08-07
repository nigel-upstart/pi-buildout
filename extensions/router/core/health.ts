/**
 * Observed endpoint health.
 *
 * A model can be scoped in, present in the registry, and still not work on this machine: a region
 * that does not carry it, a payload shape the provider rejects, an entitlement the account lacks. The
 * router should learn that from observation rather than rediscover it mid-task, so probe results and
 * live failures are recorded per endpoint and consulted during eligibility.
 *
 * Populate it with `node scripts/probe-scoped-models.ts`.
 */

const ENDPOINT_HEALTH_STATUSES = [
  "ok",
  /** 4xx: a configuration or capability problem that will recur until something changes. */
  "client_error",
  /** 5xx: the provider failed, which is usually transient. */
  "server_error",
  "timeout",
  /** Reached but unusable for a reason that did not carry an HTTP status. */
  "failed",
  /** Never probed. Absence of evidence is not evidence of failure. */
  "unknown",
] as const;

type EndpointHealthStatus = (typeof ENDPOINT_HEALTH_STATUSES)[number];

export type EndpointHealth = {
  provider: string;
  modelId: string;
  status: EndpointHealthStatus;
  httpStatus?: number;
  detail?: string;
  latencyMs?: number;
};

export type EndpointHealthRecord = {
  schemaVersion: 1;
  probedAt: string;
  endpoints: readonly EndpointHealth[];
};

export function isEndpointHealthRecord(value: unknown): value is EndpointHealthRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.probedAt !== "string" || !Array.isArray(record.endpoints)) {
    return false;
  }
  return record.endpoints.every((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const endpoint = entry as Record<string, unknown>;
    return (
      typeof endpoint.provider === "string" &&
      typeof endpoint.modelId === "string" &&
      typeof endpoint.status === "string" &&
      ENDPOINT_HEALTH_STATUSES.includes(endpoint.status as EndpointHealthStatus)
    );
  });
}

export function findEndpointHealth(
  record: EndpointHealthRecord | undefined,
  provider: string,
  modelId: string,
): EndpointHealth | undefined {
  return record?.endpoints.find((entry) => entry.provider === provider && entry.modelId === modelId);
}

export type HealthVerdict = { usable: true } | { usable: false; reason: string };

/**
 * Only a recurring failure disqualifies an endpoint. A 4xx or an otherwise-unusable response will
 * recur until the configuration changes, so routing to it wastes an attempt. A 5xx or a timeout is
 * treated as usable, because excluding an endpoint for a transient provider outage would shrink the
 * fallback chain exactly when it is most needed — the sequential fallback already handles a failure
 * that happens now.
 *
 * `unknown` is usable. An unprobed endpoint has no evidence against it, and treating silence as
 * failure would make the router depend on a probe having been run.
 */
export function healthVerdict(health: EndpointHealth | undefined): HealthVerdict {
  if (!health) return { usable: true };
  switch (health.status) {
    case "client_error":
    case "failed": {
      const status = health.httpStatus === undefined ? health.status : String(health.httpStatus);
      return {
        usable: false,
        reason: `last observation was ${status}${health.detail === undefined ? "" : `: ${health.detail}`}`,
      };
    }
    case "ok":
    case "server_error":
    case "timeout":
    case "unknown":
      return { usable: true };
  }
}
