import { z } from "zod";
import { createModel } from "./llm.js";

const PLAN_SCHEMA = z.object({
  isMultiStep: z.boolean(),
  title: z.string(),
  steps: z.array(
    z.object({
      description: z.string(),
      agent: z.enum(["clockwork", "research", "qna"]),
    }),
  ),
});

const PLANNER_PROMPT = `You decide whether a user's request needs to be broken into multiple sequential steps \
handled by different specialist agents, or whether it's simple enough for a single agent to answer directly.

Specialist agents available for steps:
- "clockwork": performs real actions against the user's time-tracking account (start/stop/delete entries, \
list projects/tasks).
- "research": investigates and synthesizes information (gathers data, summarizes findings).
- "qna": answers direct questions from general knowledge or remembered facts, no action or investigation.

Set isMultiStep=true when the request genuinely requires more than one distinct step - either across different \
agents above (e.g. "research how much time I spent on Project X last month, then start tracking time for the \
follow-up task" needs research then clockwork), OR a single broad research question that naturally breaks into \
several ordered sub-investigations under "research" alone (e.g. "research the best approach for X" might need \
separate steps to survey existing options, compare tradeoffs, and check what's already been tried before). \
Prefer decomposing an open-ended research request into concrete sub-steps rather than leaving it as one vague \
step. A single, narrow question or a single action is NOT multi-step - set isMultiStep=false and leave steps \
empty.

When isMultiStep is true, give the goal a short title and list 2-5 ordered steps, each tagged with the agent \
that should perform it.`;

export interface Plan {
  title: string;
  steps: Array<{ description: string; agent: "clockwork" | "research" | "qna" }>;
}

/** Decomposes a request into a multi-step plan when warranted; returns null for single-step requests. */
export async function planGoal(message: string): Promise<Plan | null> {
  try {
    const structuredModel = createModel(300).withStructuredOutput(PLAN_SCHEMA);
    const result = (await structuredModel.invoke([
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: message },
    ])) as z.infer<typeof PLAN_SCHEMA>;

    if (!result.isMultiStep || result.steps.length < 2) return null;
    return { title: result.title, steps: result.steps };
  } catch (error) {
    console.error("Goal planning failed:", error);
    return null;
  }
}
