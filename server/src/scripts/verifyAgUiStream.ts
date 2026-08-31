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
 * Then run: `npm run build && npm run verify:agui -- <externalUserId> "<question>" [threadId]`
 *
 * threadId is optional - pass the same one across multiple invocations to drive several turns
 * into one thread (e.g. to test memory v2's 3-turns-per-batch eligibility) instead of each call
 * getting a fresh random thread.
 */
async function main() {
  const externalUserId = process.argv[2];
  const question = process.argv[3] ?? "What is LangGraph?";
  const threadId = process.argv[4] ?? randomUUID();

  if (!externalUserId) {
    console.error('Usage: verify:agui -- <externalUserId> "<question>" [threadId]');
    process.exit(1);
  }

  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "assistant",
    threadId,
  });

  // Each call is a fresh script process with no memory of prior turns' client-side state, so a
  // hardcoded id here would collide with a previous turn's human message when reused against the
  // same thread (via the optional threadId arg) - LangGraph's add_messages reducer merges by id,
  // silently replacing that earlier message in place rather than appending, which leaves the
  // checkpointed history still ending on the earlier turn's trailing AI message and trips
  // Gemini's "Requests ending with a model turn are not supported" error on the next call.
  agent.addMessage({ id: randomUUID(), role: "user", content: question } as never);

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
