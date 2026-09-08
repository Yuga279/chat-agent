import type { EpisodeDetails, MemoryEventRecord } from "../types.js";

/** How much of the raw user/assistant text to keep in a structured field - generous enough to
 * stay informative, short enough that an episode's `content` (built from these) doesn't balloon
 * past what the retrieval token budget expects a single item to cost. */
const FIELD_CHAR_LIMIT = 400;

function truncate(text: string): string {
  return text.length <= FIELD_CHAR_LIMIT ? text : `${text.slice(0, FIELD_CHAR_LIMIT)}…`;
}

/**
 * Builds an episode's narrative structure from the event record that triggered it - the same data
 * `isEpisodeWorthy()`/the worker's episode-consolidation call site already have on hand, so this
 * requires no extra DB lookup and no LLM call. Replaces what used to be a single raw-text `content`
 * field (`content: event.assistantText`) with situation/objective/action/outcome/failure/
 * resolution/lesson - the shape the target memory taxonomy specifies for episodic memory.
 *
 * Deliberately conservative about `lesson`: it's only populated when the episode's outcome
 * actually generalizes to something worth recalling later (a recovered or unrecovered failure, a
 * multi-tool success, or a completed goal step) - not fabricated for a plain single-tool success,
 * where there's nothing to generalize from one clean call.
 */
export function buildEpisodeDetails(event: MemoryEventRecord): EpisodeDetails {
  const action = event.toolSummaries.map((t) => t.toolName);
  const failedIndex = event.toolSummaries.findIndex((t) => t.status === "error");
  const failed = failedIndex !== -1;
  const failedTool = failed ? event.toolSummaries[failedIndex].toolName : null;

  // A later tool succeeding after an earlier one failed, within the same turn, means the turn
  // recovered on its own - worth recording as the resolution, distinct from an unrecovered failure.
  const recoveredTool = failed
    ? event.toolSummaries.slice(failedIndex + 1).find((t) => t.status === "success")?.toolName ?? null
    : null;

  const objective =
    event.goalId !== null
      ? `Complete step ${(event.stepIndex ?? 0) + 1} of an active multi-step goal.`
      : "Fulfill a direct user request, possibly using tools.";

  let lesson: string | null = null;
  if (failed && recoveredTool) {
    lesson = `${recoveredTool} recovered after ${failedTool} failed - a retry/fallback path exists for this task.`;
  } else if (failed && !recoveredTool) {
    lesson = `${failedTool} failed and was not recovered within this turn.`;
  } else if (!failed && action.length > 1) {
    lesson = `Completed by chaining: ${action.join(" -> ")}.`;
  } else if (!failed && event.goalId !== null) {
    lesson = `Goal step ${(event.stepIndex ?? 0) + 1} completed successfully.`;
  }
  // Falls through to null for a plain, single-tool, non-goal success - nothing to generalize.

  return {
    situation: truncate(event.userText),
    objective,
    action,
    outcome: truncate(event.assistantText),
    failed,
    failedTool,
    resolution: recoveredTool,
    lesson,
    goalId: event.goalId,
    stepIndex: event.stepIndex,
  };
}

/**
 * The single-line, human-readable synthesis stored in `content` - what full-text search and the
 * profile/summary cards actually read. Built from the structured fields above rather than being a
 * second independent summary, so the two can never drift out of sync with each other.
 */
export function episodeContent(episode: EpisodeDetails): string {
  const parts = [`${episode.situation} -> ${episode.outcome}`];
  if (episode.lesson) parts.push(`(${episode.lesson})`);
  return parts.join(" ");
}
