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

// ---------------------------------------------------------------------------
// Memory v2: durable, scoped, low-latency agent memory (see PLAN.md).
// These types are additive - existing SemanticMemoryRecord/EpisodeRecord/
// ConversationMessageRecord above remain untouched, read-only legacy fallbacks.
// ---------------------------------------------------------------------------

export type MemoryThreadMode = "normal" | "temporary";

/** A user-owned container that scopes memory items across multiple threads. */
export interface WorkspaceRecord {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MemoryEventStatus = "pending" | "processing" | "done" | "dead";

/** One immutable outbox row per turn - the only synchronous write on the graph's
 * completion path. The memory worker leases and processes these asynchronously. */
export interface MemoryEventRecord {
  id: string;
  tenantId: string;
  userId: string;
  threadId: string;
  workspaceId: string | null;
  turnId: string;
  userText: string;
  assistantText: string;
  toolSummaries: ToolExecutionSummary[];
  goalId: string | null;
  stepIndex: number | null;
  status: MemoryEventStatus;
  attempts: number;
  lastError: string | null;
  /** Set while a worker holds the lease on this event; cleared/relet on completion or timeout. */
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MemoryItemScope = "user" | "workspace";
export type MemoryItemKind = "preference" | "fact" | "episode";
export type MemoryItemStatus = "active" | "superseded" | "deleted";
export type MemoryEmbeddingStatus = "pending" | "done" | "failed" | "skipped";

/** A v2 long-term memory item - the unit consolidation/retrieval operate on. */
export interface MemoryItemRecord {
  id: string;
  tenantId: string;
  userId: string;
  scope: MemoryItemScope;
  workspaceId: string | null;
  kind: MemoryItemKind;
  /** Stable dedupe/merge key, e.g. "user.timezone" or "preference.editor" - consolidation
   * matches on this plus scope, not on free text. */
  canonicalKey: string;
  subject: string;
  predicate: string;
  object: string;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: "none" | "sensitive";
  status: MemoryItemStatus;
  supersedes: string | null;
  validFrom: Date;
  validTo: Date | null;
  /** memory_events ids this item was derived from - used for source-aware cleanup. */
  sourceEventIds: string[];
  embedding: number[] | null;
  embeddingStatus: MemoryEmbeddingStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Rolling thread summary or compact user/workspace profile card, budgeted to a fixed
 * token size so resolveContext() can inject it cheaply. */
export interface MemorySummaryRecord {
  id: string;
  tenantId: string;
  userId: string;
  scope: "thread" | "user" | "workspace";
  /** threadId for scope "thread", workspaceId for scope "workspace", null for scope "user". */
  scopeRef: string | null;
  content: string;
  tokenBudget: number;
  /** The newest source event's createdAt this summary reflects - lets the worker skip
   * re-summarizing when nothing new has arrived. */
  sourceWatermark: Date;
  updatedAt: Date;
}

export type MemoryRevisionAction =
  | "extracted"
  | "consolidated"
  | "manual_edit"
  | "superseded"
  | "deleted"
  | "source_removed";

/** Append-only audit trail for every change to a MemoryItemRecord. */
export interface MemoryRevisionRecord {
  id: string;
  tenantId: string;
  userId: string;
  itemId: string;
  action: MemoryRevisionAction;
  before: Partial<MemoryItemRecord> | null;
  after: Partial<MemoryItemRecord> | null;
  reason: string | null;
  createdAt: Date;
}

/** Global per-user memory on/off switch (GET/PUT /api/memory/settings). Disabled means no reads
 * and no writes anywhere in the pipeline; re-enabling never backfills turns that happened while
 * paused - there is nothing to backfill from, since nothing was written during that window. */
export interface UserMemorySettingsRecord {
  tenantId: string;
  userId: string;
  enabled: boolean;
  updatedAt: Date;
}

/** Per-user/thread lease so two worker replicas never process the same batch concurrently. */
export interface MemoryWorkerLockRecord {
  id: string;
  tenantId: string;
  userId: string;
  threadId: string | null;
  ownerId: string;
  acquiredAt: Date;
  expiresAt: Date;
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
  /** Memory v2: which workspace this thread's memory items are scoped to, if any. */
  workspaceId: string | null;
  /** Memory v2: "temporary" threads never create memory events or retrieval context and
   * auto-expire (see memoryWorker's TTL sweep) if not explicitly ended. */
  memoryMode: MemoryThreadMode;
  createdAt: Date;
  updatedAt: Date;
}
