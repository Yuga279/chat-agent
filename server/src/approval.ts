import { z } from "zod";
import { createModel } from "./llm.js";

const APPROVAL_SCHEMA = z.object({
  decision: z.enum(["approve", "reject", "unclear"]),
});

const APPROVAL_PROMPT = `The user was shown a proposed multi-step plan and asked whether to proceed. Classify \
their reply:

- "approve": they said yes, go ahead, sounds good, do it, etc.
- "reject": they said no, cancel, don't do that, stop, etc.
- "unclear": the reply doesn't clearly answer yes or no (e.g. it's a question, a change request, or unrelated).`;

/** Classifies a reply to a proposed-plan prompt as approve/reject/unclear. Defaults to "unclear" on any error. */
export async function classifyApproval(message: string): Promise<"approve" | "reject" | "unclear"> {
  try {
    const structuredModel = createModel(60).withStructuredOutput(APPROVAL_SCHEMA);
    const result = (await structuredModel.invoke([
      { role: "system", content: APPROVAL_PROMPT },
      { role: "user", content: message },
    ])) as z.infer<typeof APPROVAL_SCHEMA>;

    return result.decision;
  } catch (error) {
    console.error("Approval classification failed, treating as unclear:", error);
    return "unclear";
  }
}
