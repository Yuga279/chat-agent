export type MemoryType = "semantic" | "preference" | "procedural" | "episode";

export type MemoryStatus = "active" | "superseded" | "archived" | "deleted";

/** Explicit visibility boundary for a memory row - see MemoryService.recall()/getActiveFacts()
 * for how this is enforced alongside tenantId/userId on every retrieval query. */
export type MemoryScope = "user" | "tenant" | "agent";

export type MemorySourceType = "conversation" | "explicit_tool_call" | "episode" | "system_seed";

/** Answers "why does the agent believe this" by pointing at the conversation/episode that
 * produced the fact, not just a bare category label. tenantId/userId live only on the owning
 * SemanticMemoryRecord - not duplicated here. */
export interface MemorySource {
  type: MemorySourceType;
  threadId?: string;
  sessionId?: string;
  messageIds?: string[];
  episodeId?: string;
  agent: "assistant";
}

/** A durable semantic-memory fact (including user preferences), scoped to a user (tenant support left as a column for future multi-tenant use). */
export interface SemanticMemoryRecord {
  id: string;
  tenantId: string;
  userId: string;
  scope: MemoryScope;
  type: MemoryType;
  subject: string;
  predicate: string;
  object: string;
  content: string;
  source: MemorySource;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  supersedes: string | null;
  validFrom: Date;
  validTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Embedding of `content`, used for semantic recall. Null when no embedding provider is configured. */
  embedding: number[] | null;
}

export interface ConversationMessageRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** The LangGraph thread this message belongs to. Mandatory going forward; null only on rows
   * backfilled from before this field existed - see the schema redesign's migration notes. */
  threadId: string | null;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/** A single tool call made during an episode's run - kept as a lightweight summary; raw
 * arguments/results are never persisted here (or anywhere else - the standalone
 * tool_executions/ToolExecutionRecord collection this used to feed was write-only, with no
 * reader anywhere in the codebase, so it was removed rather than folded in verbatim). */
export interface ToolExecutionSummary {
  toolName: string;
  /** "timeout" is reserved for when tool-call timeout enforcement exists - nothing in
   * runReactLoop (assistantGraph.ts) currently enforces a per-call timeout, so no code path
   * produces it yet. */
  status: "success" | "error" | "timeout";
  startedAt: Date | null;
  durationMs: number;
}

export interface EpisodeRecord {
  tenantId: string;
  userId: string;
  /** Mandatory going forward; null only on rows backfilled from before this field existed. */
  threadId: string | null;
  /** Set when this episode came from executing one step of a durable goal. */
  goalId: string | null;
  stepIndex: number | null;
  task: string;
  actions: ToolExecutionSummary[];
  outcome: string;
  success: boolean;
  failureReason: string | null;
  createdAt: Date;
  importance: number;
  /** Embedding of `task`, used for semantic similar-experience lookup. Null when unavailable. */
  embedding: number[] | null;
}

/** A candidate fact pulled from a message, before it becomes a SemanticMemoryRecord. */
export interface ExtractedFact {
  memoryType: MemoryType | "ignore";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  /** The model's own estimate of how useful/durable this fact is for future conversations, 0-1. */
  importance: number;
  reason: string;
}

export interface IMemoryImportanceScorer {
  score(fact: ExtractedFact): number;
}

export interface IMemoryExtractor {
  extract(message: string): Promise<ExtractedFact[]>;
}

export type GoalStatus = "proposed" | "active" | "done" | "abandoned";
export type GoalStepStatus = "pending" | "done";

export interface GoalStep {
  stepId: string;
  title: string;
  description?: string;
  status: GoalStepStatus;
}

/** A persistent, multi-step objective that survives across turns/sessions. */
export interface GoalRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** The thread that proposed this goal. Mandatory going forward; null only on rows backfilled
   * from before this field existed. */
  threadId: string | null;
  title: string;
  status: GoalStatus;
  steps: GoalStep[];
  currentStepIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Native thread/session metadata - merges what used to be two separate mapping collections
 * (thread_owners, default_thread_pointers). _id IS the LangGraph threadId, so uniqueness (the
 * ownership-claim safety property) comes from Mongo's own _id index for free, and `isDefault`
 * (enforced unique per tenantId+userId via a partial index - see ensureThreadIndexes) replaces
 * the separate default-thread pointer. */
export interface ThreadRecord {
  _id: string;
  tenantId: string;
  userId: string;
  title?: string;
  status: "active" | "archived";
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}
