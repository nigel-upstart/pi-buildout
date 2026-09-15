/**
 * Modified from upstream pi-otel 0.3.0: the string-attribute byte cap is a
 * parameter rather than a module-private constant, truncation is exact, and the
 * cache/reasoning token keys carry the current GenAI registry spelling
 * alongside the pre-1.44 spelling for dashboard compatibility.
 *
 * gen_ai.* attribute and metric constants.
 *
 * Names follow the OTel GenAI semantic conventions:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

// Conversation / agent identity
export const ATTR_CONVERSATION_ID = "gen_ai.conversation.id";
export const ATTR_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_AGENT_VERSION = "gen_ai.agent.version";
export const ATTR_USER_ID = "user.id";

// Errors
export const ATTR_ERROR_TYPE = "error.type";

// Operation / provider
export const ATTR_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_SYSTEM = "gen_ai.system";
export const ATTR_PROVIDER_NAME = "gen_ai.provider.name";

// Request
export const ATTR_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const ATTR_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const ATTR_REQUEST_TOP_P = "gen_ai.request.top_p";

// Response
export const ATTR_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_FINISH_REASONS = "gen_ai.response.finish_reasons";

// Usage
export const ATTR_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_TOKEN_TYPE = "gen_ai.token.type";

/**
 * Cache and reasoning token keys, current GenAI registry spelling (verified
 * against `@opentelemetry/semantic-conventions@1.43.0`, which exports these as
 * `ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS`,
 * `ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS`, and
 * `ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS`).
 */
export const ATTR_CACHE_READ_TOKENS = "gen_ai.usage.cache_read.input_tokens";
export const ATTR_CACHE_CREATION_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";
export const ATTR_REASONING_TOKENS = "gen_ai.usage.reasoning.output_tokens";

/**
 * Pre-1.44 spellings this extension emitted before the registry adopted the
 * dotted form. They are written alongside the registry keys above so existing
 * dashboards and saved queries keep resolving; drop them only with a migration
 * note.
 */
export const ATTR_CACHE_READ_TOKENS_LEGACY =
  "gen_ai.usage.cache_read_input_tokens";
export const ATTR_CACHE_CREATION_TOKENS_LEGACY =
  "gen_ai.usage.cache_creation_input_tokens";
export const ATTR_REASONING_TOKENS_LEGACY = "gen_ai.usage.reasoning_tokens";

/**
 * Cache-write tokens have no GenAI registry attribute as of 1.43.0 (the
 * registry defines only `cache_read` and `cache_creation`), so this key is
 * deliberately left at its existing spelling rather than invented into a
 * registry-looking name.
 */
export const ATTR_CACHE_WRITE_TOKENS = "gen_ai.usage.cache_write_input_tokens";

// Tool
export const ATTR_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_TOOL_TYPE = "gen_ai.tool.type";
export const ATTR_TOOL_DESCRIPTION = "gen_ai.tool.description";
export const ATTR_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const ATTR_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

// Pi-specific attributes (SPEC §5.4)
export const ATTR_PI_SESSION_ID = "pi.session.id";
export const ATTR_SESSION_ID = "session.id";
export const ATTR_PI_CWD = "pi.cwd";
export const ATTR_PI_TURN_COUNT = "pi.turn_count";
export const ATTR_PI_TURN_INDEX = "pi.turn_index";
export const ATTR_PI_TOOL_COUNT = "pi.tool_count";
export const ATTR_PI_TOOL_NAME = "pi.tool.name";
export const ATTR_PI_TOOL_CALL_ID = "pi.tool.call_id";
export const ATTR_PI_TOOL_IS_ERROR = "pi.tool.is_error";
export const ATTR_PI_TOOL_INPUT = "pi.tool.input";
export const ATTR_PI_TOOL_OUTPUT = "pi.tool.output";
export const ATTR_PI_COST_USD = "pi.cost.usd";
// Set when the LLM span was opened from the assistant message_start instead
// of before_provider_request, i.e. the provider skipped options.onPayload.
export const ATTR_PI_LLM_SYNTHESIZED = "pi.llm_request.synthesized";
export const ATTR_PI_USER_PROMPT = "pi.user_prompt";
export const ATTR_PI_USER_PROMPT_LENGTH = "pi.user_prompt_length";

// HTTP
export const ATTR_HTTP_STATUS_CODE = "http.response.status_code";

// GenAI message-list attributes (Aspire 9.x AI panel reads these on the LLM span)
export const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";

// GenAI span events
export const EVENT_GEN_AI_USER_MESSAGE = "gen_ai.user.message";
export const EVENT_GEN_AI_TOOL_MESSAGE = "gen_ai.tool.message";
export const EVENT_GEN_AI_ASSISTANT_MESSAGE = "gen_ai.assistant.message";
export const EVENT_GEN_AI_CHOICE = "gen_ai.choice";

// Span names
export const SPAN_INTERACTION = "pi.interaction";
export const SPAN_LLM_REQUEST = "pi.llm_request";
export const SPAN_TURN = "pi.turn";
export const spanToolName = (name: string) => `pi.tool.${name}`;

// gen_ai.operation.name values. Literals retain compatibility with semantic-conventions 1.28.0.
export const OP_CHAT = "chat";
export const OP_EXECUTE_TOOL = "execute_tool";
export const OP_INVOKE_AGENT = "invoke_agent";

/**
 * Span naming mode. `legacy` keeps the historical `pi.*` names (dashboards and
 * saved queries depend on them); `genai` emits the OTel GenAI agent span names
 * (`invoke_agent {agent}` / `chat {model}` / `execute_tool {tool}`) plus
 * `gen_ai.operation.name`, the spec SpanKind, `gen_ai.agent.name` on the
 * interaction span, and `gen_ai.provider.name` on chat spans only. No
 * attribute present in `legacy` is ever removed in `genai`.
 */
export type SpanNaming = "legacy" | "genai";

export const GEN_AI_AGENT_NAME_PI = "pi";

// Value used for ATTR_SYSTEM across this extension.
export const GEN_AI_SYSTEM_PI = "pi";

// captureContent trichotomy (lifted from sigil-pi audit)
export type ContentCapture = "metadata_only" | "no_tool_content" | "full";

/**
 * Default cap for a single string attribute, in UTF-8 bytes.
 *
 * 60 KiB matches Claude Code (SPEC §7) and is the value upstream applied
 * unconditionally, so it stays the default for compatibility. Deployments that
 * export to a collector able to accept larger attributes raise it through
 * `otel.maxAttributeBytes`.
 */
export const DEFAULT_MAX_ATTRIBUTE_BYTES = 60 * 1024;

const TRUNCATION_SUFFIX = "…[truncated]";
const TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 * Cutting a UTF-8 buffer at an arbitrary index can land inside a multi-byte
 * sequence, so back off while the first dropped byte is a continuation byte
 * (`0b10xxxxxx`).
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Serialize a value and cap it at `maxBytes` UTF-8 bytes, marking any
 * truncation. The returned string is never larger than `maxBytes`.
 *
 * This runs before the SDK's own `spanLimits.attributeValueLengthLimit`
 * (`OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`), which defaults to unlimited and can
 * only truncate further, never raise this cap.
 */
export function clampAttr(
  value: unknown,
  maxBytes: number = DEFAULT_MAX_ATTRIBUTE_BYTES,
): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      // JSON.stringify is typed as returning string but yields undefined for
      // undefined, functions, and symbols, which would throw in byteLength.
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Too small to carry the marker: emit content only, still within the cap.
  if (maxBytes <= TRUNCATION_SUFFIX_BYTES) return truncateUtf8(s, maxBytes);
  return `${truncateUtf8(s, maxBytes - TRUNCATION_SUFFIX_BYTES)}${TRUNCATION_SUFFIX}`;
}

/**
 * Pull token + cost data off a pi assistant message.usage object onto a span attributes record.
 * Tolerant of missing fields — pi providers differ in what they populate.
 */
export function applyUsageAttrs(
  attrs: Record<string, unknown>,
  usage: unknown,
): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, any>;
  const set = (k: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) attrs[k] = v;
  };
  // Registry key plus the pre-1.44 spelling, so a rename cannot silently blind
  // an existing dashboard.
  const setDual = (registryKey: string, legacyKey: string, v: unknown) => {
    set(registryKey, v);
    set(legacyKey, v);
  };
  set(ATTR_INPUT_TOKENS, u.input ?? u.inputTokens ?? u.input_tokens);
  set(ATTR_OUTPUT_TOKENS, u.output ?? u.outputTokens ?? u.output_tokens);
  setDual(
    ATTR_CACHE_READ_TOKENS,
    ATTR_CACHE_READ_TOKENS_LEGACY,
    u.cacheRead ?? u.cache_read ?? u.cacheReadTokens,
  );
  set(
    ATTR_CACHE_WRITE_TOKENS,
    u.cacheWrite ?? u.cache_write ?? u.cacheWriteTokens,
  );
  setDual(
    ATTR_CACHE_CREATION_TOKENS,
    ATTR_CACHE_CREATION_TOKENS_LEGACY,
    u.cacheCreation ?? u.cache_creation ?? u.cacheCreationTokens,
  );
  setDual(
    ATTR_REASONING_TOKENS,
    ATTR_REASONING_TOKENS_LEGACY,
    u.reasoning ?? u.reasoningTokens ?? u.reasoning_tokens,
  );
  const cost = u.cost;
  if (cost && typeof cost === "object") {
    const total = (cost as any).total;
    if (typeof total === "number" && Number.isFinite(total)) {
      attrs[ATTR_PI_COST_USD] = total;
    }
  }
}
