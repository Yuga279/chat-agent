import { z } from "zod";
import { createModel } from "./llm.js";

const ROUTE_SCHEMA = z.object({
  agent: z.enum(["clockwork", "research", "qna"]),
  reason: z.string(),
});

const ROUTER_PROMPT = `You route a chat message to exactly one specialist agent. Pick based on what the user is \
asking for:

- "clockwork": the user wants to DO something with time tracking - start/stop/delete a time entry, check a \
running timer, list projects/tasks. Anything that requires calling a real tool against their System1 account.
- "research": the user wants an investigation or open-ended lookup that should gather and synthesize \
information (not a simple fact recall), e.g. "find out how much time was spent on Project X last month and \
summarize it".
- "qna": a direct question that can be answered from general knowledge or from what's already remembered about \
the user (preferences, past decisions, "why did you...", "what's my preferred currency"), with no action or \
deep investigation needed.

Default to "clockwork" when the message is ambiguous or is a short follow-up in an ongoing task.`;

/** LLM-based intent router: picks which specialist agent should handle a message. */
export async function routeToAgent(message: string): Promise<"clockwork" | "research" | "qna"> {
  try {
    const structuredModel = createModel(100).withStructuredOutput(ROUTE_SCHEMA);
    const result = (await structuredModel.invoke([
      { role: "system", content: ROUTER_PROMPT },
      { role: "user", content: message },
    ])) as z.infer<typeof ROUTE_SCHEMA>;

    return result.agent;
  } catch (error) {
    console.error("Agent routing failed, defaulting to clockwork:", error);
    return "clockwork";
  }
}
