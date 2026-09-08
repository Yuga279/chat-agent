import { z } from "zod";
import { silentJsonCompletion } from "../../silentModel.js";
import type { MemoryEventRecord } from "../types.js";
import { SEMANTIC_SUBTYPES } from "./taxonomy.js";

/** Bumped whenever the prompt or candidate schema below changes, so an item's provenance says
 * which extractor shape produced it. Recorded in MemoryProvenance.extractionVersion. */
export const EXTRACTOR_VERSION = "2";

/**
 * The extractor only ever proposes *semantic* candidates. Episodes are derived deterministically
 * by the worker from tool activity and goal progress - asking the model to also decide "was this
 * an episode" duplicated a judgement the event record already answers precisely. Procedural
 * memory is never extracted from a single batch at all; it is promoted from repeated episodes
 * under its own governance.
 */
const CANDIDATE_ITEM_SCHEMA = z.object({
  subtype: z.enum(SEMANTIC_SUBTYPES),
  canonicalKey: z
    .string()
    .describe("Stable dedupe key, e.g. 'user.timezone' or 'preference.editor' - lowercase, dot-separated."),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  content: z.string().describe("One-sentence natural-language statement of the fact/preference."),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  /** 1-based index into the batch's transcript, matching the "Turn N:" labels the prompt renders.
   * Lets the worker attribute the candidate to the single turn that stated it instead of to the
   * whole batch. Coerced because models routinely return this as a string. */
  sourceTurn: z.coerce.number().int().min(1).optional(),
});

// Models occasionally ignore the "wrap in {candidates: [...]}" instruction and return a bare
// JSON array instead (observed in practice with Gemini) - preprocess normalizes that shape before
// validating, so a real response isn't thrown away just because the wrapper object is missing.
const CANDIDATE_SCHEMA = z.preprocess(
  (value) => (Array.isArray(value) ? { candidates: value } : value),
  z.object({ candidates: z.array(CANDIDATE_ITEM_SCHEMA) }),
);

export type ExtractionCandidate = z.infer<typeof CANDIDATE_ITEM_SCHEMA>;

const EXTRACTOR_PROMPT = `You extract durable, reusable memory candidates from a batch of chat turns (user \
message + assistant reply + tool activity) so they can be recalled in future, unrelated conversations.

Extract a candidate only when it is durable and would still matter in a different conversation. Classify \
each one with a subtype:
- "fact": a stable fact about the user/customer/project (role, tier, tech stack, recurring constraint).
- "preference": an explicit preference (format, currency, units, language, tools, style).
- "entity": a named thing that matters to this user (a project, system, client, repository).
- "relationship": how two things relate (user works on project X; project X depends on service Y).
- "stable_context": a longer-lived situational fact that is true for now but will eventually change \
(current role, current focus area, current environment).

Do NOT extract one-off requests, greetings, small talk, or anything only true for the current task. If \
nothing durable is present, return an empty list. Assign each candidate a canonicalKey that would stay \
stable if the same fact were restated differently later (so a new value naturally supersedes the old one \
under the same key), a confidence (how sure you are this is true) and an importance (how much it would \
matter to recall in a future, unrelated conversation) - these are different judgements, so do not just \
repeat the same number for both. Set sourceTurn to the number of the single turn that stated it.

Respond with ONLY a JSON object (no markdown, no code fences, no commentary) matching exactly this shape:
{"candidates": [{"subtype": "fact"|"preference"|"entity"|"relationship"|"stable_context", "canonicalKey": string, "subject": string, "predicate": string, "object": string, "content": string, "confidence": number, "importance": number, "sourceTurn": number}]}
"candidates" must be [] when nothing durable is present in this batch. Always return the wrapper object above - \
never a bare array.`;

/** Extraction is the only LLM-in-the-loop step in the v2 pipeline; everything downstream
 * (policy/consolidation/lifecycle) is deterministic. Runs inside the worker, never on the graph's
 * hot path, so it's fine for this to be relatively slow. */
export class MemoryExtractor {
  async extractFromEvents(events: MemoryEventRecord[], maxTokens = 1000): Promise<ExtractionCandidate[]> {
    if (events.length === 0) return [];

    const turnsText = events
      .map((e, i) => `Turn ${i + 1}:\nUser: ${e.userText}\nAssistant: ${e.assistantText}`)
      .join("\n\n");

    try {
      const result = await silentJsonCompletion<{ candidates: ExtractionCandidate[] }>(EXTRACTOR_PROMPT, turnsText, CANDIDATE_SCHEMA, maxTokens);
      // A model that cites a turn outside the batch would otherwise silently mis-attribute
      // provenance, which is worse than admitting the turn is unknown.
      return result.candidates.map((c) =>
        c.sourceTurn !== undefined && c.sourceTurn > events.length ? { ...c, sourceTurn: undefined } : c,
      );
    } catch (error) {
      console.error("MemoryExtractor.extractFromEvents failed - skipping this batch's extraction:", error);
      return [];
    }
  }
}

export const memoryExtractor = new MemoryExtractor();
