import { tool } from "@langchain/core/tools";
import { callMcpTool, isNotLinkedResult, listMcpTools } from "../mcpClient.js";

/** Builds one LangChain tool per MCP tool, bound to a single chat user via closure. */
export async function buildTools(externalUserId: string) {
  const mcpTools = await listMcpTools();

  return mcpTools.map((mcpTool) =>
    tool(
      async (args: Record<string, unknown>) => {
        // Some models emit "" for an optional field instead of omitting it; an empty string
        // fails strict server-side validation (e.g. startTime as a DateTime) where omitting
        // the field entirely would have been fine, so treat "" the same as "not provided".
        const cleanedArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== ""));

        let result: unknown;
        try {
          result = await callMcpTool(externalUserId, mcpTool.name, cleanedArgs);
        } catch (error) {
          console.error(`MCP tool "${mcpTool.name}" call failed:`, error);
          // Deliberately NOT phrased like a not-linked error - a weak model will otherwise
          // invent a plausible-looking "please link your account" story instead of reporting
          // the real failure when it sees any error here.
          return (
            "TOOL_CALL_FAILED: the System1 service did not respond (network/timeout error), not an " +
            "account-linking issue. Tell the user the ClockWork service is temporarily unavailable and to " +
            "try again shortly. Do not mention linking an account or invent any URL."
          );
        }

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
