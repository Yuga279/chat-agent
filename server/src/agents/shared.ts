import type { AIMessageChunk } from "@langchain/core/messages";
import { DEFAULT_TENANT_ID } from "../constants.js";

export { DEFAULT_TENANT_ID };

// Reused by src/graph/researchGraph.ts (the AG-UI/LangGraph execution path) - the legacy
// REST/SSE wrapWithConversationMemory() that used to live in this file has been removed since
// its only callers (runAgent/runResearchAgent/runQnaAgent) no longer exist.
export function extractText(content: AIMessageChunk["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => "type" in part && part.type === "text")
    .map((part) => part.text)
    .join("");
}
