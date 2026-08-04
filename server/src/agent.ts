import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { config } from "./config.js";
import { callMcpTool, isNotLinkedResult, listMcpTools } from "./mcpClient.js";

const model = new ChatOpenAI({
  apiKey: config.openRouterApiKey,
  model: config.modelName,
  maxTokens: 500,
  configuration: { baseURL: "https://openrouter.ai/api/v1" },
});

/** Builds one LangChain tool per MCP tool, bound to a single chat user via closure. */
async function buildTools(externalUserId: string) {
  const mcpTools = await listMcpTools();

  return mcpTools.map((mcpTool) =>
    tool(
      async (args: Record<string, unknown>) => {
        const result = await callMcpTool(externalUserId, mcpTool.name, args);
        if (isNotLinkedResult(result)) {
          return `This user hasn't linked their System1 account yet. Tell them to connect it here: ${result.linkUrl}`;
        }

        return JSON.stringify(result);
      },
      {
        name: mcpTool.name,
        description: mcpTool.description ?? mcpTool.name,
        schema: mcpTool.inputSchema as never,
      },
    ),
  );
}

const SYSTEM_PROMPT = `You are a ClockWork time-tracking assistant, chatting with a human over text.

## Acting on requests
- When the user asks you to do something (start, stop, or delete a time entry), call the relevant tool \
right away using only the arguments they gave you.
- Never ask the user to supply a value for an optional tool argument - just omit it and let the tool's own \
defaults apply. Only ask a clarifying question when a *required* argument is missing and can't be inferred \
from the conversation.

## Responding to the user
Tool results are raw JSON meant for you, not the user - never paste, quote, or dump any part of a tool's raw \
JSON response into your reply. Always translate it into a short, natural, human-readable message instead.
- Lead with what happened, in plain language (e.g. "Started tracking time on TK1-dev." / "Stopped your entry - \
you tracked 2m 48s.").
- Mention project/task by their display name only (e.g. "PR1-SystemOne / TK1-dev"), never their GUID/ID.
- Don't include internal identifiers, employee IDs, timezone metadata, image URLs, or other system fields - the \
user never needs to see those.
- Keep it to one or two short sentences unless the user asks for more detail. No headers, bullet lists, or bold \
labels for a simple confirmation - talk like a helpful coworker, not a report.
- If a tool call fails or the account isn't linked, say so plainly and give the one actionable next step (e.g. \
the link-account URL) without extra commentary.`;

export async function runAgent(
  externalUserId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const tools = await buildTools(externalUserId);
  const agent = createReactAgent({ llm: model, tools });

  return agent.stream(
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    },
    { streamMode: "messages" },
  );
}
