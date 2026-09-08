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
// Durable, scoped, low-latency agent memory - the only memory pipeline now (the earlier
// synchronous v1 pipeline and its SemanticMemoryRecord/EpisodeRecord/ConversationMessageRecord
// types have been removed).
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
  /** Exponential backoff gate: null (eligible immediately) until a failure sets it to a future
   * instant, so a retried event doesn't become re-eligible in the same poll cycle that just failed
   * it - without this, one broken event and its batch-mates could burn all their attempts within
   * seconds of each other instead of spreading retries out. */
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MemoryItemScope = "user" | "workspace";

/** The memory category. See v2/taxonomy.ts for the kind -> subtype mapping and scope rules. */
export type MemoryKind = "semantic" | "episodic" | "procedural";

/** Semantic memory's members. Factual memory is a *subtype* of semantic memory, not a separate
 * store - the same collection holds all of these, distinguished by this field. */
export type SemanticSubtype = "fact" | "preference" | "entity" | "relationship" | "stable_context";
export type EpisodicSubtype = "episode";
export type ProceduralSubtype = "procedure";
export type MemorySubtype = SemanticSubtype | EpisodicSubtype | ProceduralSubtype;

/** "expired" is reached by the worker's lifecycle sweep once validTo passes; it is distinct from
 * "superseded" (replaced by a newer value) and "deleted" (removed by a user or by source cleanup),
 * so the audit trail can tell the three apart. */
export type MemoryItemStatus = "active" | "superseded" | "expired" | "deleted";
export type MemoryEmbeddingStatus = "pending" | "done" | "failed" | "skipped";

/** How a durable memory came to exist. Written by the worker (extraction), the remember_fact tool
 * (explicit_tool), or the memories API (user_edit). */
export type MemorySourceType = "extraction" | "explicit_tool" | "user_edit";
export type MemoryActorType = "worker" | "user";

/**
 * Answers "why does the system believe this?" for a single memory item. Every durable write
 * carries one; nothing is stored without provenance.
 *
 * `sourceEventIds` deliberately stays a top-level field on MemoryItemRecord rather than moving in
 * here - it backs both a Mongo index and the source-aware thread-deletion cleanup, and relocating
 * it would mean rewriting a working deletion path for no functional gain.
 */
export interface MemoryProvenance {
  sourceType: MemorySourceType;
  actorType: MemoryActorType;
  /** The user on whose behalf the write happened (the worker acts for a user, never for itself). */
  actorId: string;
  sourceThreadId: string | null;
  sourceGoalId: string | null;
  /** turnIds of the specific turns this item was derived from. Narrower than sourceEventIds when
   * the extractor attributed a candidate to one turn of a multi-turn batch, so provenance points
   * at the turn that actually stated the fact rather than the whole batch. */
  sourceTurnIds: string[];
  extractedAt: Date | null;
  /** Resolved provider model id that produced the extraction, and the extractor prompt/schema
   * version - so an item's origin stays interpretable after either one changes. */
  extractionModel: string | null;
  extractionVersion: string | null;
}

/**
 * Where a procedural memory item stands in the promotion pipeline (Episode -> Candidate ->
 * Validation -> Active). "candidate" is the only entry state - a procedure is never written
 * straight to "active", however clean its first run: repeated success is the whole point of the
 * pipeline, not a formality. "rejected" is terminal by design (see procedurePolicy.ts) - once a
 * pattern has shown itself unreliable often enough, it does not quietly earn its way back in.
 * "deprecated" is reserved for a procedure that *was* active and started failing - a demotion, not
 * a rejection, since it may have been a real change in the environment rather than a bad procedure.
 */
export type ProcedureValidationStatus = "candidate" | "active" | "rejected" | "deprecated";

/**
 * The "how" that makes a procedural memory item different from a semantic or episodic one.
 * Populated only when `kind` is "procedural" - `assertValidTaxonomy`'s callers additionally check
 * this is present for that kind (see repository.ts's upsertByCanonicalKey).
 */
export interface ProcedureDetails {
  /** The ordered steps this procedure consists of. Today these are always a tool-call sequence
   * (see procedureCandidates.ts) - literally "call X, then Y, then Z" - rather than free-text
   * instructions, since that is what the pipeline can currently observe and verify success/failure
   * against without an extra LLM call. */
  steps: string[];
  successCount: number;
  failureCount: number;
  validationStatus: ProcedureValidationStatus;
}

/** A v2 long-term memory item - the unit consolidation/retrieval operate on. */
export interface MemoryItemRecord {
  id: string;
  tenantId: string;
  userId: string;
  scope: MemoryItemScope;
  workspaceId: string | null;
  kind: MemoryKind;
  subtype: MemorySubtype;
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
  /** Monotonic revision number under this canonical key: a superseding write carries its
   * predecessor's version + 1, so the chain length is readable from any single row. */
  version: number;
  /** Backward pointer to the item this one replaced. Never overwritten after insert. */
  supersedes: string | null;
  /** Forward pointer, set on the *old* item when it is superseded. Kept separate from
   * `supersedes` so the version chain is walkable in both directions - a single field used for
   * both directions clobbers the predecessor link and makes history unreconstructable. */
  supersededBy: string | null;
  validFrom: Date;
  /** Expiry instant, or null for no automatic expiry. Assigned per subtype - see
   * v2/taxonomy.ts's expiresAtFor(). */
  validTo: Date | null;
  /** memory_events ids this item was derived from - used for source-aware cleanup. */
  sourceEventIds: string[];
  provenance: MemoryProvenance;
  /** Present only when kind is "procedural". */
  procedure?: ProcedureDetails;
  embedding: number[] | null;
  embeddingStatus: MemoryEmbeddingStatus;
  /** Consecutive embedding failures. A transient failure (below the retry cap) leaves
   * embeddingStatus as "pending" so the next worker pass retries it automatically; only once this
   * is exhausted does embeddingStatus become the terminal "failed" - previously any single failure
   * (a momentary Gemini blip included) was permanent. */
  embeddingAttempts: number;
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
  | "source_removed"
  | "expired"
  | "restored"
  | "merged"
  /** A candidate the policy gate refused. Recorded with itemId null, since no item was created -
   * without this, a rejected sensitive fact left no trace at all, which is precisely the case an
   * operator most needs to be able to review. */
  | "rejected";

/** Append-only audit trail for every change to a MemoryItemRecord. */
export interface MemoryRevisionRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** Null only for "rejected", where the candidate never became an item. */
  itemId: string | null;
  action: MemoryRevisionAction;
  /** Who performed the mutation. Distinguishes a worker extraction from a user edit without
   * having to infer it from the action name. */
  actorType: MemoryActorType;
  actorId: string;
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
  /** Memory v2: "temporary" threads never create memory events or retrieval context. They are
   * hidden from GET /api/threads rather than expired - nothing sweeps thread rows (the worker's
   * lifecycle sweep operates on memory_items), so one persists until explicitly ended or deleted. */
  memoryMode: MemoryThreadMode;
  createdAt: Date;
  updatedAt: Date;
}
