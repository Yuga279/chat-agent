export type MemoryType = "semantic" | "preference" | "procedural" | "episode";

export type MemoryStatus = "active" | "superseded" | "archived" | "deleted";

/** Explicit visibility boundary for a memory row - see MemoryService.recall()/getActiveFacts()
 * for how this is enforced alongside tenantId/userId on every retrieval query. */
export type MemoryScope = "user" | "tenant" | "agent";

export type MemorySourceType = "conversation" | "explicit_tool_call" | "episode" | "system_seed";

/** Answers "why does the agent believe this" by pointing at the conversation/episode that
 * produced the fact, not just a bare category label. */
export interface MemorySource {
  type: MemorySourceType;
  tenantId: string;
  userId: string;
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
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
}

/** A single tool call made during an episode's run - kept as a lightweight summary, never
 * arguments/results (those live in ToolExecutionRecord, looked up separately by episodeId). */
export interface ToolExecutionSummary {
  toolName: string;
  status: "success" | "error";
  startedAt: string | null;
}

export interface EpisodeRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** Mandatory going forward; null only on rows backfilled from before this field existed. */
  threadId: string | null;
  sessionId: string | null;
  /** Set when this episode came from executing one step of a durable goal. */
  goalId: string | null;
  stepIndex: number | null;
  task: string;
  actions: ToolExecutionSummary[];
  outcome: string;
  success: boolean;
  failureReason: string | null;
  createdAt: string;
  importance: number;
  /** Embedding of `task`, used for semantic similar-experience lookup. Null when unavailable. */
  embedding: number[] | null;
}

/** Detailed record of a single tool invocation, looked up by episodeId when full
 * arguments/results are needed beyond an episode's ToolExecutionSummary. Arguments/results are
 * redacted/truncated on write - never store raw sensitive tool payloads. */
export interface ToolExecutionRecord {
  id: string;
  tenantId: string;
  userId: string;
  threadId: string | null;
  sessionId: string | null;
  episodeId: string;
  toolName: string;
  argumentsRedacted: Record<string, unknown> | null;
  resultSummary: string;
  status: "success" | "error";
  startedAt: string;
  completedAt: string;
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
  createdAt: string;
  updatedAt: string;
}
