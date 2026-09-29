type Payload = Record<string, unknown>;

function payloadObject(payload: unknown): Payload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cannot require a tool call on a non-object provider payload");
  }
  return { ...(payload as Payload) };
}

/** Add the provider-native request field that requires one specific structured tool call. */
export function requireToolCall(payload: unknown, api: string, toolName: string): Payload {
  const next = payloadObject(payload);
  switch (api) {
    case "openai-completions":
      next.tool_choice = { type: "function", function: { name: toolName } };
      break;
    case "openai-responses":
    case "openai-codex-responses":
      next.tool_choice = { type: "function", name: toolName };
      break;
    case "anthropic-messages":
      next.tool_choice = { type: "tool", name: toolName };
      break;
    case "google-generative-ai":
    case "google-vertex":
      next.toolConfig = {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
      };
      break;
    case "bedrock-converse-stream": {
      // Converse nests the forced choice beside the tool specs in `toolConfig`. Without tool specs
      // there is nothing to force, and Bedrock rejects a bare toolChoice, so fail closed instead.
      const toolConfig = next.toolConfig;
      if (
        !toolConfig ||
        typeof toolConfig !== "object" ||
        Array.isArray(toolConfig) ||
        !Array.isArray((toolConfig as Payload).tools) ||
        ((toolConfig as Payload).tools as unknown[]).length === 0
      ) {
        throw new Error("Cannot require a tool call on a Bedrock payload without toolConfig");
      }
      next.toolConfig = { ...(toolConfig as Payload), toolChoice: { tool: { name: toolName } } };
      // Claude rejects budget-style extended thinking (`type: "enabled"`) alongside a forced tool
      // choice, which failed every Bedrock Haiku classifier call. Adaptive thinking is accepted, so
      // only the budget form and its interleaved-thinking beta are removed.
      const fields = next.additionalModelRequestFields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        const thinking = (fields as Payload).thinking;
        if (thinking && typeof thinking === "object" && (thinking as Payload).type === "enabled") {
          const rest: Payload = { ...(fields as Payload) };
          delete rest.thinking;
          delete rest.anthropic_beta;
          next.additionalModelRequestFields = Object.keys(rest).length > 0 ? rest : undefined;
        }
      }
      break;
    }
    default:
      throw new Error(`Required tool calls are not configured for API ${api}`);
  }
  return next;
}
