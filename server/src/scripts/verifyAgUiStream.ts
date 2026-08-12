import { randomUUID } from "node:crypto";
import { LangGraphAgent } from "@ag-ui/langgraph";

/**
 * Standalone smoke test: proves the AG-UI <-> LangGraph wiring works end-to-end, bypassing
 * Express/CopilotKit entirely, for the single "assistant" graph. Requires two things running
 * first:
 *
 *   1. `npm run graph:dev` (in this directory) - starts the LangGraph.js dev server on
 *      port 2024, serving the "assistant" graph from langgraph.json.
 *   2. MongoDB and the System1.MCP server up, same as for `npm start` (the graph's tool
 *      list comes from the same buildTools()/memory-tools path as the main server).
 *
 * Then run: `npm run build && npm run verify:agui -- <externalUserId> "<question>"`
 */
async function main() {
  const externalUserId = process.argv[2];
  const question = process.argv[3] ?? "What is LangGraph?";

  if (!externalUserId) {
    console.error('Usage: verify:agui -- <externalUserId> "<question>"');
    process.exit(1);
  }

  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "assistant",
    threadId: randomUUID(),
  });

  agent.addMessage({ id: "1", role: "user", content: question } as never);

  console.log(`Running assistant graph for externalUserId=${externalUserId!}...\n`);

  const result = await agent.runAgent(
    {
      forwardedProps: { config: { configurable: { externalUserId } } },
    },
    {
      onEvent: async ({ event }) => {
        console.log(`[event] ${event.type}`);
      },
      onTextMessageContentEvent: async ({ event }) => {
        process.stdout.write(event.delta);
      },
    },
  );

  console.log("\n\n--- final messages ---");
  console.log(JSON.stringify(result.newMessages, null, 2));
}

main().catch((error) => {
  console.error("verify:agui failed:", error);
  process.exit(1);
});
