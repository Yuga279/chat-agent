import { tool } from "@langchain/core/tools";
import { callMcpTool, isNotLinkedResult, listMcpTools } from "../mcpClient.js";

/** Builds one LangChain tool per MCP tool, bound to a single chat user via closure. */
export async function buildTools(externalUserId: string) {
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
