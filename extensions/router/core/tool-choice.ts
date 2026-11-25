import { canonicalModelId } from "./scope.ts";

type Payload = Record<string, unknown>;

function object(value: unknown): Payload | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : undefined;
}

function bedrockToolConfig(payload: Payload): Payload {
  const config = object(payload.toolConfig);
  if (!config || !Array.isArray(config.tools) || config.tools.length === 0) {
    throw new Error("Cannot require a tool call on a Bedrock payload without toolConfig");
  }
  return config;
}

function removeBedrockBudgetThinking(payload: Payload): void {
  const fields = object(payload.additionalModelRequestFields);
  if (!fields || object(fields.thinking)?.type !== "enabled") return;
  const rest = { ...fields };
  delete rest.thinking;
  const betas = Array.isArray(rest.anthropic_beta)
    ? rest.anthropic_beta.filter(
        (beta: unknown) => typeof beta !== "string" || !beta.startsWith("interleaved-thinking-"),
      )
    : [];
  if (betas.length > 0) rest.anthropic_beta = betas;
  else delete rest.anthropic_beta;
  payload.additionalModelRequestFields = Object.keys(rest).length > 0 ? rest : undefined;
}

/** Request the structured tool call. The caller still rejects missing or schema-invalid results. */
export function requireToolCall(payload: unknown, api: string, toolName: string, modelId = ""): Payload {
  const source = object(payload);
  if (!source) throw new Error("Cannot require a tool call on a non-object provider payload");
  const next = { ...source };
  // Sonnet 5.5 rejects named/forced tool choice. At classifier effort, between_tools avoids
  // up-front thinking; the prompt requests the tool and the response validator enforces it.
  const sonnet55 = canonicalModelId(modelId) === "claude-sonnet-5-5";
  switch (api) {
    case "openai-completions":
      next.tool_choice = { type: "function", function: { name: toolName } };
      break;
    case "openai-responses":
    case "openai-codex-responses":
      next.tool_choice = { type: "function", name: toolName };
      break;
    case "anthropic-messages":
      if (sonnet55) {
        next.tool_choice = { type: "auto" };
        next.thinking = { type: "between_tools" };
        next.output_config = { ...object(next.output_config), effort: "low" };
      } else {
        next.tool_choice = { type: "tool", name: toolName };
        // Manual budget thinking is incompatible with a forced tool (legacy Haiku).
        if (object(next.thinking)?.type === "enabled") delete next.thinking;
      }
      break;
    case "google-generative-ai":
    case "google-vertex":
      next.toolConfig = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
      };
      break;
    case "bedrock-converse-stream": {
      const config = bedrockToolConfig(next);
      if (sonnet55) {
        const fields = object(next.additionalModelRequestFields);
        next.toolConfig = { ...config, toolChoice: { auto: {} } };
        next.additionalModelRequestFields = {
          ...fields,
          thinking: { type: "between_tools" },
          output_config: { ...object(fields?.output_config), effort: "low" },
        };
      } else {
        next.toolConfig = { ...config, toolChoice: { tool: { name: toolName } } };
        removeBedrockBudgetThinking(next);
      }
      break;
    }
    default:
      throw new Error(`Required tool calls are not configured for API ${api}`);
  }
  return next;
}
