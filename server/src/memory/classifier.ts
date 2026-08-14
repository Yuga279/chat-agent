import { z } from "zod";
import { createModel } from "../llm.js";
import type { ExtractedFact, IMemoryExtractor } from "./types.js";

const FACT_SCHEMA = z.object({
  facts: z.array(
    z.object({
      memoryType: z.enum(["semantic", "episode", "ignore"]),
      subject: z.string().describe("Who/what the fact is about, e.g. 'user'"),
      predicate: z.string().describe("The relationship, e.g. 'prefers_currency'"),
      object: z.string().describe("The value, e.g. 'INR'"),
      confidence: z.number().min(0).max(1),
      importance: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "How useful this fact would be to recall in future, unrelated conversations - 0 for a minor detail, " +
            "1 for something that should shape almost every future interaction (e.g. a hard constraint or core preference).",
        ),
      reason: z.string(),
    }),
  ),
});

const CLASSIFIER_PROMPT = `You extract durable, reusable facts from a single chat message so they can be \
remembered across future conversations. Only extract facts that are:
- Explicit statements of user preference (formats, currency, units, language, style), or
- Stable facts about the user/customer/project (roles, tiers, tech stack, recurring constraints).

Do NOT extract:
- One-off requests, greetings, or questions with no durable fact.
- Anything that is only true for this single task (that belongs in working memory, not here).

If nothing durable is present, return an empty facts array. Use memoryType "ignore" for weak candidates \
you decide not to keep. For every fact you do keep, also estimate its importance (0-1): how much it would \
matter to recall in a future, unrelated conversation.`;

/** LLM-backed classifier. Swappable via the IMemoryExtractor interface. */
export class LlmMemoryExtractor implements IMemoryExtractor {
  async extract(message: string): Promise<ExtractedFact[]> {
    const structuredModel = createModel(300).withStructuredOutput(FACT_SCHEMA);

    try {
      const result = (await structuredModel.invoke([
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: message },
      ])) as z.infer<typeof FACT_SCHEMA>;

      return result.facts.filter((f) => f.memoryType !== "ignore") as ExtractedFact[];
    } catch (error) {
      console.error("Memory classification failed:", error);
      return [];
    }
  }
}
