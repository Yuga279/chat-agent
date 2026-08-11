import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { model } from "../llm.js";
import { connectDb } from "../db.js";
import { ensureMemoryIndexes } from "../memory/collections.js";

const MAX_TOOL_ITERATIONS = 6;

let readyPromise: Promise<void> | undefined;
/** Standalone-host bootstrap (see researchGraph.ts's ensureReady doc) - shared here so clockwork
 * and qna graphs don't each duplicate it. */
export function ensureGraphReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = connectDb().then(() => ensureMemoryIndexes());
  }
  return readyPromise;
}

/**
 * Builds a single-node ReAct-loop LangGraph graph: same shape as the original createAgent()-based
 * agent, just re-hosted as a graph node so it's servable via langgraph.json/AG-UI like research.
 * `getTools` and `getSystemPrompt` are resolved per-invocation from `config.configurable.externalUserId`
 * since one compiled graph is shared across every user's threads (see researchGraph.ts's agentNode).
 */
export function buildSimpleAgentGraph(
  getTools: (externalUserId: string) => Promise<StructuredToolInterface[]>,
  getSystemPrompt: (externalUserId: string) => Promise<string>,
) {
  async function agentNode(state: typeof MessagesAnnotation.State, config: RunnableConfig) {
    const externalUserId = config.configurable?.externalUserId as string | undefined;
    if (!externalUserId) {
      throw new Error("This graph requires config.configurable.externalUserId");
    }

    await ensureGraphReady();

    const tools = await getTools(externalUserId);
    const toolsByName = new Map(tools.map((t) => [t.name, t as { invoke: (input: unknown, config?: unknown) => Promise<unknown> }]));
    const modelWithTools = model.bindTools(tools);
    const systemPrompt = await getSystemPrompt(externalUserId);

    let messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...state.messages];
    const newMessages: Array<AIMessage | ToolMessage> = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await modelWithTools.invoke(messages, config);
      newMessages.push(response);
      messages = [...messages, response];

      if (!response.tool_calls?.length) break;

      for (const call of response.tool_calls) {
        const tool = toolsByName.get(call.name);
        const result: unknown = tool ? await tool.invoke(call.args, config) : `Unknown tool: ${call.name}`;
        const toolMessage = new ToolMessage({
          content: typeof result === "string" ? result : JSON.stringify(result),
          tool_call_id: call.id ?? "",
          name: call.name,
        });
        newMessages.push(toolMessage);
        messages = [...messages, toolMessage];
      }
    }

    return { messages: newMessages };
  }

  return new StateGraph(MessagesAnnotation).addNode("agent", agentNode).addEdge(START, "agent").addEdge("agent", END).compile();
}
