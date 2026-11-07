// One chat model serves MCP auto-tagging. The id comes from the AI_MODEL
// Worker var when it is set, matching SMSinBox, and otherwise the default below.

export const DEFAULT_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export function resolveAiModel(env: { AI_MODEL?: string } | null | undefined): string {
  const configured = env?.AI_MODEL?.trim();
  return configured ? configured : DEFAULT_AI_MODEL;
}

// Workers AI answers either as { response } or as an OpenAI chat completion
// { choices: [{ message: { content } }] }. Content may be a string or parts.
export function readChatResponse(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (typeof output !== "object" || output === null) return null;
  const response = (output as { response?: unknown }).response;
  if (typeof response === "string") return response;
  const choices = (output as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  return readContent((message as { content?: unknown }).content);
}

function readContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const part of content) {
    if (typeof part === "string") text += part;
    else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      text += (part as { text: string }).text;
    }
  }
  return text.length > 0 ? text : null;
}
