import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ENV = "PI_SIMPLE_SUBAGENT_AUTH_PROVIDER";
const API_KEY_ENV = "PI_SIMPLE_SUBAGENT_API_KEY";
const HEADERS_ENV = "PI_SIMPLE_SUBAGENT_AUTH_HEADERS";

const UNSAFE = /[\0\r\n]/;

/** Only accept a flat string map whose entries cannot inject extra headers. */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !key || UNSAFE.test(key) || UNSAFE.test(value)) return undefined;
    headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Invocation-private bridge for runtime-only parent credentials (for example
 * `pi --api-key ...`). The child process receives the secrets in its environment,
 * never in argv, and applies them only to the selected provider. Normal persisted
 * auth continues to work unchanged.
 *
 * Headers travel with the API key because `registerProvider` replaces the whole
 * stored provider request config, so registering an API key alone would drop the
 * provider's configured headers (including an `authHeader` bearer) in the child.
 * `env` is deliberately not bridged: the child re-reads provider env from the
 * same persisted auth storage as the parent.
 */
export default function subagentAuthBridge(pi: ExtensionAPI) {
  const provider = process.env[PROVIDER_ENV]?.trim();
  const apiKey = process.env[API_KEY_ENV];
  const headers = parseHeaders(process.env[HEADERS_ENV]);
  Reflect.deleteProperty(process.env, PROVIDER_ENV);
  Reflect.deleteProperty(process.env, API_KEY_ENV);
  Reflect.deleteProperty(process.env, HEADERS_ENV);
  if (!provider || UNSAFE.test(provider)) return;
  if (!apiKey && !headers) return;
  pi.registerProvider(provider, {
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
  });
}
