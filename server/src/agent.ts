import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { config } from "./config.js";
import { callMcpTool, isNotLinkedResult, listMcpTools } from "./mcpClient.js";

const model = new ChatAnthropic({ apiKey: config.anthropicApiKey, model: config.modelName });

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

export async function runAgent(
  externalUserId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const tools = await buildTools(externalUserId);
  const agent = createReactAgent({ llm: model, tools });

  return agent.stream(
    { messages: messages.map((m) => ({ role: m.role, content: m.content })) },
    { streamMode: "messages" },
  );
}
