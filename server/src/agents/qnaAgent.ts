import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { model } from "../llm.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { memoryService } from "../memory/memoryService.js";
import { DEFAULT_TENANT_ID, wrapWithConversationMemory } from "./shared.js";

const SYSTEM_PROMPT = `You are a Q&A assistant. Answer the user's question directly and concisely.

- Use recall_memory to check for any remembered fact or preference relevant to the question before answering \
(e.g. if asked "why did you generate PDF", recall the preference history instead of guessing).
- You cannot take actions or call external systems - if the question requires that, say so and suggest asking \
the ClockWork assistant instead.
- Only call remember_fact when the user states something explicitly durable about themselves; do not remember \
the question itself.`;

/** Read-only Q&A agent: no MCP action tools, shares the same memory store as other agents. */
export async function runQnaAgent(
  externalUserId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const tools = buildMemoryTools(DEFAULT_TENANT_ID, externalUserId);
  const agent = createReactAgent({ llm: model, tools });

  const sessionId = `${externalUserId}:qna`;
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

  return wrapWithConversationMemory(stream, externalUserId, sessionId, latestUserMessage?.content);
}
