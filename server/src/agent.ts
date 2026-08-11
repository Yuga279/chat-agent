import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { model } from "./llm.js";
import { buildTools } from "./agents/sharedTools.js";
import { buildMemoryTools, composePreferenceContext } from "./memory/memoryTools.js";
import { memoryService } from "./memory/memoryService.js";
import { DEFAULT_TENANT_ID, wrapWithConversationMemory } from "./agents/shared.js";

const SYSTEM_PROMPT = `You are a ClockWork time-tracking assistant, chatting with a human over text.

## Acting on requests
- When the user asks you to do something (start, stop, or delete a time entry), call the relevant tool \
right away using only the arguments they gave you.
- Never ask the user to supply a value for an optional tool argument - just omit it and let the tool's own \
defaults apply. Only ask a clarifying question when a *required* argument is missing and can't be inferred \
from the conversation.
- If you already called a tool this turn and it returned "not_linked", do NOT call it again - go straight to \
the linking instructions below using that same result.

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
- If a tool result has "error": "not_linked", tell the user their account isn't linked and give them the link, \
using the EXACT "linkUrl" string from that tool result, character for character - copy-paste it, never \
paraphrase, shorten, guess, or invent a URL (e.g. never write something like "https://your-link-account-url" - \
that is not a real link). If you have no tool result with a real linkUrl in this conversation, say you're not \
sure and ask the user to try again, instead of making up a URL.`;

export async function runAgent(
  externalUserId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const mcpTools = await buildTools(externalUserId);
  const tools = [...mcpTools, ...buildMemoryTools(DEFAULT_TENANT_ID, externalUserId)];
  const agent = createReactAgent({ llm: model, tools });

  const sessionId = externalUserId;
  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (latestUserMessage) {
    await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, sessionId, "user", latestUserMessage.content);
    // Fire-and-forget: extraction shouldn't block the response.
    memoryService.extractAndPersist(DEFAULT_TENANT_ID, externalUserId, latestUserMessage.content).catch((error) => {
      console.error("Memory extraction failed:", error);
    });
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
