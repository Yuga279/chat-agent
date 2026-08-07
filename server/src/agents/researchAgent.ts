import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { model } from "../llm.js";
import { buildTools } from "./sharedTools.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { memoryService } from "../memory/memoryService.js";
import { DEFAULT_TENANT_ID, wrapWithConversationMemory } from "./shared.js";

const SYSTEM_PROMPT = `You are a research assistant that investigates questions using the available tools and \
remembered context before answering.

- Check memory first (recall_memory, get_similar_experiences) for relevant prior facts or past approaches to \
similar research tasks, and reuse a working approach instead of starting from scratch.
- Use the available data tools to gather current information rather than guessing.
- When you finish, give a clear, well-organized answer citing what you found, and call remember_fact for any \
durable fact worth keeping for future questions (not for one-off findings).
- Be explicit when you are uncertain or a source is missing rather than fabricating an answer.`;

export async function runResearchAgent(
  externalUserId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const mcpTools = await buildTools(externalUserId);
  const tools = [...mcpTools, ...buildMemoryTools(DEFAULT_TENANT_ID, externalUserId)];
  const agent = createReactAgent({ llm: model, tools });

  const sessionId = `${externalUserId}:research`;
  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (latestUserMessage) {
    await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, sessionId, "user", latestUserMessage.content);
  }

  const preferenceContext = await composePreferenceContext(DEFAULT_TENANT_ID, externalUserId);
  const systemPrompt = preferenceContext ? `${SYSTEM_PROMPT}\n\n${preferenceContext}` : SYSTEM_PROMPT;

  const stream = await agent.stream(
    {
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    },
    { streamMode: "messages" },
  );

  return wrapWithConversationMemory(stream, externalUserId, sessionId, latestUserMessage?.content, {
    task: latestUserMessage?.content ?? "research task",
  });
}
