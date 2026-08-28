import { z } from "zod";
import { silentJsonCompletion } from "../../silentModel.js";
import type { MemoryEventRecord } from "../types.js";

const CANDIDATE_SCHEMA = z.object({
  candidates: z.array(
    z.object({
      kind: z.enum(["preference", "fact", "episode"]),
      canonicalKey: z
        .string()
        .describe("Stable dedupe key, e.g. 'user.timezone' or 'preference.editor' - lowercase, dot-separated."),
      subject: z.string(),
      predicate: z.string(),
      object: z.string(),
      content: z.string().describe("One-sentence natural-language statement of the fact/preference/episode."),
      confidence: z.number().min(0).max(1),
      importance: z.number().min(0).max(1),
    }),
  ),
});

export type ExtractionCandidate = z.infer<typeof CANDIDATE_SCHEMA>["candidates"][number];

const EXTRACTOR_PROMPT = `You extract durable, reusable memory candidates from a batch of chat turns (user \
message + assistant reply + tool activity) so they can be recalled in future, unrelated conversations.

Extract a candidate only when it is:
- An explicit, durable user preference (formats, currency, units, language, tools, style), or
- A stable fact about the user/customer/project (roles, tiers, tech stack, recurring constraints), or
- A notable episode worth recalling later (a completed multi-step task, a failure and its cause, explicit \
user feedback about how something went).

Do NOT extract one-off requests, greetings, small talk, or anything only true for the current task. If \
nothing durable is present in a turn, contribute nothing for it. Assign each candidate a canonicalKey that \
would stay stable if the same fact were restated differently later (so a new value naturally supersedes the \
old one under the same key), a confidence (how sure you are this is true) and an importance (how much it \
would matter to recall in a future, unrelated conversation).`;

/** Extraction is the only LLM-in-the-loop step in the v2 pipeline; everything downstream
 * (policy/consolidation) is deterministic. Runs inside the worker, never on the graph's hot path,
 * so it's fine for this to be relatively slow. */
export class MemoryExtractor {
  async extractFromEvents(events: MemoryEventRecord[], maxTokens = 1000): Promise<ExtractionCandidate[]> {
    if (events.length === 0) return [];

    const turnsText = events
      .map((e, i) => `Turn ${i + 1}:\nUser: ${e.userText}\nAssistant: ${e.assistantText}`)
      .join("\n\n");

    try {
      const result = await silentJsonCompletion(EXTRACTOR_PROMPT, turnsText, CANDIDATE_SCHEMA, maxTokens);
      return result.candidates;
    } catch (error) {
      console.error("MemoryExtractor.extractFromEvents failed - skipping this batch's extraction:", error);
      return [];
    }
  }
}

export const memoryExtractor = new MemoryExtractor();
