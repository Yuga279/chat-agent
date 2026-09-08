import { randomUUID } from "node:crypto";
import {
  NO_ID_PROJECTION,
  memoryEventsCollection,
  memoryItemsCollection,
  memoryRevisionsCollection,
  memorySummariesCollection,
  memoryWorkerLocksCollection,
} from "../collections.js";
import type {
  MemoryActorType,
  MemoryEventRecord,
  MemoryItemRecord,
  MemoryItemScope,
  MemoryKind,
  MemoryProvenance,
  MemoryRevisionAction,
  MemorySubtype,
  MemorySummaryRecord,
  ProcedureDetails,
} from "../types.js";
import { assertValidTaxonomy, expiresAtFor } from "./taxonomy.js";
import { memoryMetrics } from "./metrics.js";

/** Exponential backoff for a failed event: 30s, 2m, 8m, 32m, capped at 30min - spread out enough
 * that a transient failure (a momentary LLM/DB blip) doesn't retry into the same failure again
 * within seconds, without making the last-chance retry before "dead" wait unreasonably long. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

function backoffDelayMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 4 ** (attempts - 1));
}

/** A transient embedding failure retries automatically (stays "pending"); only after this many
 * consecutive failures does an item's embeddingStatus become the terminal "failed". */
const MAX_EMBEDDING_ATTEMPTS = 5;

export interface UpsertByCanonicalKeyInput {
  tenantId: string;
  userId: string;
  scope: MemoryItemScope;
  workspaceId: string | null;
  kind: MemoryKind;
  subtype: MemorySubtype;
  canonicalKey: string;
  subject: string;
  predicate: string;
  object: string;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: MemoryItemRecord["sensitivity"];
  sourceEventIds: string[];
  provenance: MemoryProvenance;
  /** Required when, and only meaningful when, `kind` is "procedural" - enforced in
   * upsertByCanonicalKey rather than left to convention, since a procedural item silently missing
   * this would have no steps, no success/failure record, and no validation status at all. */
  procedure?: ProcedureDetails;
  /** The currently-active item under this canonical key, if the caller already looked one up
   * (e.g. to make its own decision about whether to write at all) - passed in rather than
   * re-queried here to avoid a redundant findActiveItemByCanonicalKey round-trip. */
  existing: MemoryItemRecord | null;
  /** Revision action recorded against the newly-inserted item - callers differ on whether this
   * came from an explicit tool call ("manual_edit") or worker extraction ("extracted"). */
  revisionAction: MemoryRevisionAction;
  revisionReason?: string | null;
}

/**
 * Thin Mongo access layer for the memory collections - MemoryWorker/MemoryConsolidator/
 * MemoryRetriever go through this rather than calling collections.ts directly, so the storage
 * shape can change without touching worker logic.
 */
export class MemoryRepository {
  // --- memory_events (outbox) ---------------------------------------------------------------

  async enqueueEvent(
    event: Omit<
      MemoryEventRecord,
      "id" | "status" | "attempts" | "lastError" | "leaseOwner" | "leaseExpiresAt" | "nextAttemptAt" | "createdAt" | "updatedAt"
    >,
  ): Promise<MemoryEventRecord> {
    const now = new Date();
    const record: MemoryEventRecord = {
      ...event,
      id: randomUUID(),
      status: "pending",
      attempts: 0,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await memoryEventsCollection().insertOne(record);
    memoryMetrics.increment("memory_events_enqueued");
    return record;
  }

  /** An event is eligible for (re-)leasing when it is freshly "pending" and past its backoff gate,
   * OR when it is "processing" but its lease has expired - the latter is what reclaims a batch a
   * worker crashed on: previously "processing" was written once and read by nothing, so a killed
   * worker's events were stranded there forever with no reaper. Both branches match `now`
   * identically in findEligibleGroup and leaseEventsForGroup, so what one finds the other can lease. */
  private eligibilityFilter(now: Date) {
    return {
      $or: [
        { status: "pending" as const, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { status: "processing" as const, leaseExpiresAt: { $lt: now } },
      ],
    };
  }

  /** Finds one user/thread group *within this tenant* with a pending batch ready to process: at
   * least `minTurns` eligible events, or an oldest one older than `maxAgeMs`. Returns null when
   * nothing is eligible yet. Scoped by `tenantId` in both the match and the group key - previously
   * this aggregation had no tenant in it at all, so a second tenant's events could in principle be
   * grouped/processed alongside this one's under a colliding userId. */
  async findEligibleGroup(
    tenantId: string,
    minTurns: number,
    maxAgeMs: number,
  ): Promise<{ userId: string; threadId: string } | null> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const now = new Date();
    const groups = await memoryEventsCollection()
      .aggregate<{ _id: { userId: string; threadId: string }; count: number; oldest: Date }>([
        { $match: { tenantId, ...this.eligibilityFilter(now) } },
        { $group: { _id: { userId: "$userId", threadId: "$threadId" }, count: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
        { $match: { $or: [{ count: { $gte: minTurns } }, { oldest: { $lte: cutoff } }] } },
        { $sort: { oldest: 1 } },
        { $limit: 1 },
      ])
      .toArray();
    const group = groups[0];
    return group ? { userId: group._id.userId, threadId: group._id.threadId } : null;
  }

  /** Atomically leases up to `limit` eligible events for one tenant/user/thread, oldest first -
   * the unit of work a single processBatch() call processes together. Picks up both fresh-pending
   * and reclaimed-from-a-dead-lease events via the same eligibilityFilter findEligibleGroup used to
   * find this group in the first place. */
  async leaseEventsForGroup(
    tenantId: string,
    userId: string,
    threadId: string,
    ownerId: string,
    leaseMs: number,
    limit: number,
  ): Promise<MemoryEventRecord[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const filter = { tenantId, userId, threadId, ...this.eligibilityFilter(now) };
    const ids = await memoryEventsCollection()
      .find(filter, { projection: { _id: 0, id: 1 } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
    if (ids.length === 0) return [];

    await memoryEventsCollection().updateMany(
      { id: { $in: ids.map((i) => i.id) } },
      { $set: { status: "processing", leaseOwner: ownerId, leaseExpiresAt, updatedAt: now } },
    );

    return memoryEventsCollection()
      .find({ id: { $in: ids.map((i) => i.id) } }, NO_ID_PROJECTION)
      .sort({ createdAt: 1 })
      .toArray();
  }

  async markEventsDone(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await memoryEventsCollection().updateMany(
      { id: { $in: ids } },
      { $set: { status: "done", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() } },
    );
    memoryMetrics.increment("memory_events_done", ids.length);
  }

  /** Reverts a lease on failure: back to "pending" behind an exponential backoff gate, with an
   * incremented attempt count, or "dead" once attempts is exhausted (never retried again, but left
   * in place for inspection). Previously this cleared `leaseExpiresAt` to null with no backoff at
   * all, so a failed event (and every other event failed alongside it in the same batch) was
   * immediately re-eligible on the very next poll - a single poison event could burn all of a
   * batch's attempts within seconds. */
  async failEvent(id: string, error: string, maxAttempts: number): Promise<void> {
    const event = await memoryEventsCollection().findOne({ id }, NO_ID_PROJECTION);
    if (!event) return;
    const attempts = event.attempts + 1;
    const dead = attempts >= maxAttempts;
    await memoryEventsCollection().updateOne(
      { id },
      {
        $set: {
          status: dead ? "dead" : "pending",
          attempts,
          lastError: error,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: dead ? null : new Date(Date.now() + backoffDelayMs(attempts)),
          updatedAt: new Date(),
        },
      },
    );
    memoryMetrics.increment(dead ? "memory_events_dead" : "memory_events_retried");
  }

  // --- memory_items --------------------------------------------------------------------------

  async findActiveItemByCanonicalKey(
    tenantId: string,
    userId: string,
    scope: MemoryItemRecord["scope"],
    workspaceId: string | null,
    canonicalKey: string,
  ): Promise<MemoryItemRecord | null> {
    return memoryItemsCollection().findOne(
      { tenantId, userId, scope, workspaceId, canonicalKey, status: "active" },
      NO_ID_PROJECTION,
    );
  }

  async insertItem(item: Omit<MemoryItemRecord, "id" | "createdAt" | "updatedAt">): Promise<MemoryItemRecord> {
    const now = new Date();
    const record: MemoryItemRecord = { ...item, id: randomUUID(), createdAt: now, updatedAt: now };
    await memoryItemsCollection().insertOne(record);
    return record;
  }

  /** Marks the previous item superseded and records which item replaced it. This writes
   * `supersededBy` and deliberately leaves `supersedes` untouched: `supersedes` is the old item's
   * own backward link to *its* predecessor, and overwriting it (as this method used to) collapsed
   * the version chain so history could not be walked past one hop. */
  async supersedeItem(oldId: string, newId: string): Promise<void> {
    await memoryItemsCollection().updateOne(
      { id: oldId },
      { $set: { status: "superseded", supersededBy: newId, updatedAt: new Date() } },
    );
  }

  /**
   * Shared write path for "store or update a fact under this canonical key": inserts the new
   * item (pointing `supersedes` at whatever was active before, if anything), flips the old one to
   * "superseded" and records that, then records the new item's own revision. Used by both
   * `remember_fact` (explicit tool call) and `MemoryConsolidator` (worker extraction) - the two
   * call sites only differ in confidence/importance defaults and which `revisionAction` applies.
   */
  async upsertByCanonicalKey(input: UpsertByCanonicalKeyInput): Promise<MemoryItemRecord> {
    const { tenantId, userId, scope, workspaceId, canonicalKey, existing, revisionAction, revisionReason, ...fields } = input;

    // The application, never the model, decides scope - and a subtype must belong to its kind.
    // Enforced here because this is the single write path both the worker and remember_fact share.
    assertValidTaxonomy(fields.kind, fields.subtype, scope);
    if (fields.kind === "procedural" && !fields.procedure) {
      throw new Error("Invalid memory write: kind \"procedural\" requires a `procedure` payload.");
    }

    const now = new Date();
    const item = await this.insertItem({
      tenantId,
      userId,
      scope,
      workspaceId,
      canonicalKey,
      status: "active",
      version: (existing?.version ?? 0) + 1,
      supersedes: existing?.id ?? null,
      supersededBy: null,
      validFrom: now,
      validTo: expiresAtFor(fields.subtype, now),
      embedding: null,
      embeddingStatus: "pending",
      embeddingAttempts: 0,
      ...fields,
    });

    const { actorType, actorId } = fields.provenance;

    if (existing) {
      await this.supersedeItem(existing.id, item.id);
      await this.recordRevision({
        tenantId,
        userId,
        itemId: existing.id,
        action: "superseded",
        actorType,
        actorId,
        before: existing,
        after: { supersededBy: item.id, status: "superseded" },
      });
    }
    await this.recordRevision({
      tenantId,
      userId,
      itemId: item.id,
      action: revisionAction,
      actorType,
      actorId,
      before: null,
      after: item,
      reason: revisionReason ?? null,
    });

    return item;
  }

  /**
   * Lifecycle sweep: moves items whose expiry has passed from "active" to "expired" and records an
   * "expired" revision for each. Expiry is assigned per subtype at write time (see taxonomy.ts);
   * subtypes with no TTL carry validTo: null and are never touched here. Bounded per call so the
   * worker's tick stays predictable. Returns how many items it expired.
   */
  async expireStaleItems(limit: number, now: Date = new Date()): Promise<number> {
    const stale = await memoryItemsCollection()
      .find({ status: "active", validTo: { $ne: null, $lt: now } }, NO_ID_PROJECTION)
      .limit(limit)
      .toArray();

    for (const item of stale) {
      await memoryItemsCollection().updateOne({ id: item.id }, { $set: { status: "expired", updatedAt: now } });
      await this.recordRevision({
        tenantId: item.tenantId,
        userId: item.userId,
        itemId: item.id,
        action: "expired",
        actorType: "worker",
        actorId: item.userId,
        before: item,
        after: { status: "expired" },
        reason: `validTo ${item.validTo?.toISOString()} passed`,
      });
    }
    return stale.length;
  }

  /**
   * Same-value restatement: strengthens the existing item in place instead of inserting a new
   * version. Without this, a fact the user repeats every few conversations produced an unbounded
   * insert/supersede chain and a matching pile of revision rows, all describing an unchanged value.
   * Confidence and importance only ever move up here - a restatement is corroboration, so it must
   * not be able to weaken what is already on file - and the expiry window is extended, since the
   * memory has just been shown to still be current.
   */
  async reinforceItem(
    item: MemoryItemRecord,
    incoming: { confidence: number; importance: number; sourceEventIds: string[] },
  ): Promise<MemoryItemRecord> {
    const now = new Date();
    const mergedSources = [...new Set([...item.sourceEventIds, ...incoming.sourceEventIds])];
    const patch = {
      confidence: Math.max(item.confidence, incoming.confidence),
      importance: Math.max(item.importance, incoming.importance),
      sourceEventIds: mergedSources,
      validTo: expiresAtFor(item.subtype, now),
      updatedAt: now,
    };

    await memoryItemsCollection().updateOne({ id: item.id }, { $set: patch });
    await this.recordRevision({
      tenantId: item.tenantId,
      userId: item.userId,
      itemId: item.id,
      action: "consolidated",
      actorType: "worker",
      actorId: item.userId,
      before: { confidence: item.confidence, importance: item.importance, validTo: item.validTo },
      after: { confidence: patch.confidence, importance: patch.importance, validTo: patch.validTo },
      reason: "same value restated - reinforced existing item instead of superseding it",
    });

    return { ...item, ...patch };
  }

  /**
   * Records one more observed outcome (success or failure) against a procedural memory item
   * *without* creating a new version - the same "mutate in place" reasoning as reinforceItem,
   * applied to procedures: incrementing a running count is not a change to what the procedure
   * *is*, so it doesn't need its own version in the chain the way a governance-status change does.
   * That status change, when it happens, goes through upsertByCanonicalKey instead (see
   * proceduralMemory.ts) - so a rollback can always point at the exact version where a procedure
   * was promoted, demoted or rejected, not just at "sometime after count N."
   */
  async updateProcedureCounts(
    item: MemoryItemRecord & { procedure: ProcedureDetails },
    outcome: { successCount: number; failureCount: number; sourceEventIds: string[] },
  ): Promise<MemoryItemRecord> {
    const now = new Date();
    const procedure: ProcedureDetails = {
      ...item.procedure,
      successCount: outcome.successCount,
      failureCount: outcome.failureCount,
    };
    const sourceEventIds = [...new Set([...item.sourceEventIds, ...outcome.sourceEventIds])];

    await memoryItemsCollection().updateOne({ id: item.id }, { $set: { procedure, sourceEventIds, updatedAt: now } });
    await this.recordRevision({
      tenantId: item.tenantId,
      userId: item.userId,
      itemId: item.id,
      action: "consolidated",
      actorType: "worker",
      actorId: item.userId,
      before: { procedure: item.procedure },
      after: { procedure },
      reason: `procedure outcome recorded (successCount=${procedure.successCount}, failureCount=${procedure.failureCount})`,
    });

    return { ...item, procedure, sourceEventIds, updatedAt: now };
  }

  /**
   * On success, clears the attempt counter and marks the item embedded. On failure, increments
   * the attempt counter but leaves `embeddingStatus` at "pending" until MAX_EMBEDDING_ATTEMPTS is
   * reached - a transient failure (a momentary Gemini blip, a rate limit) is retried automatically
   * on the next embedPendingItems() pass, since that query already selects everything "pending".
   * Previously a *single* failure jumped straight to the terminal "failed" status, so any hiccup
   * permanently removed the item from vector retrieval.
   */
  async setEmbedding(id: string, embedding: number[] | null): Promise<void> {
    if (embedding) {
      await memoryItemsCollection().updateOne(
        { id },
        { $set: { embedding, embeddingStatus: "done", embeddingAttempts: 0, updatedAt: new Date() } },
      );
      return;
    }

    const item = await memoryItemsCollection().findOne({ id }, NO_ID_PROJECTION);
    const attempts = (item?.embeddingAttempts ?? 0) + 1;
    const exhausted = attempts >= MAX_EMBEDDING_ATTEMPTS;
    await memoryItemsCollection().updateOne(
      { id },
      {
        $set: {
          embedding: null,
          embeddingAttempts: attempts,
          embeddingStatus: exhausted ? "failed" : "pending",
          updatedAt: new Date(),
        },
      },
    );
    if (exhausted) memoryMetrics.increment("embeddings_permanently_failed");
  }

  async listPendingEmbeddings(limit: number): Promise<MemoryItemRecord[]> {
    return memoryItemsCollection()
      .find({ embeddingStatus: "pending", status: "active" }, NO_ID_PROJECTION)
      .limit(limit)
      .toArray();
  }

  async getOwnedItem(tenantId: string, userId: string, id: string): Promise<MemoryItemRecord | null> {
    return memoryItemsCollection().findOne({ id, tenantId, userId }, NO_ID_PROJECTION);
  }

  /** Manual correction via the Memory management UI/API - always active status, writes a
   * "manual_edit" revision so the audit trail shows a human changed it, not the worker. */
  async updateItemFields(
    tenantId: string,
    userId: string,
    id: string,
    patch: Partial<Pick<MemoryItemRecord, "subject" | "predicate" | "object" | "content" | "importance">>,
  ): Promise<MemoryItemRecord | null> {
    const before = await this.getOwnedItem(tenantId, userId, id);
    if (!before) return null;
    await memoryItemsCollection().updateOne(
      { id, tenantId, userId },
      { $set: { ...patch, embeddingStatus: patch.content ? "pending" : before.embeddingStatus, updatedAt: new Date() } },
    );
    const after = await this.getOwnedItem(tenantId, userId, id);
    await this.recordRevision({
      tenantId,
      userId,
      itemId: id,
      action: "manual_edit",
      actorType: "user",
      actorId: userId,
      before,
      after,
      reason: "user edit via /api/memories",
    });
    return after;
  }

  /** Shared by every "mark this item deleted and record why" call site - deleteOwnedItem,
   * deleteItemsByScope, purgeWorkspace all just differ in which items they select and what reason
   * string to attach. */
  private async softDeleteItem(
    tenantId: string,
    userId: string,
    item: MemoryItemRecord,
    reason: string,
    actorType: MemoryActorType = "user",
  ): Promise<void> {
    await memoryItemsCollection().updateOne({ id: item.id }, { $set: { status: "deleted", updatedAt: new Date() } });
    await this.recordRevision({
      tenantId,
      userId,
      itemId: item.id,
      action: "deleted",
      actorType,
      actorId: userId,
      before: item,
      after: null,
      reason,
    });
  }

  async deleteOwnedItem(tenantId: string, userId: string, id: string): Promise<boolean> {
    const before = await this.getOwnedItem(tenantId, userId, id);
    if (!before) return false;
    await this.softDeleteItem(tenantId, userId, before, "user delete via /api/memories");
    return true;
  }

  async deleteItemsByScope(
    tenantId: string,
    userId: string,
    scope: MemoryItemRecord["scope"],
    workspaceId: string | null,
  ): Promise<number> {
    const items = await memoryItemsCollection()
      .find({ tenantId, userId, scope, workspaceId, status: "active" }, NO_ID_PROJECTION)
      .toArray();
    for (const item of items) {
      await this.softDeleteItem(tenantId, userId, item, "user clear-all via /api/memories");
    }
    return items.length;
  }

  /**
   * The public-facing listing behind GET /api/memories - two things distinguish it from the other
   * internal list methods on this class: it never returns `embedding` (a ~3072-float vector per
   * item that has no business reaching a browser - previously this method used the same
   * NO_ID_PROJECTION every internal caller does, which omits `_id` but not `embedding`), and it's
   * paginated rather than returning the user's entire memory in one response.
   */
  async listItems(
    tenantId: string,
    userId: string,
    filter: { scope?: MemoryItemRecord["scope"]; workspaceId?: string | null } = {},
    pagination: { limit?: number; before?: Date } = {},
  ): Promise<{ items: Array<Omit<MemoryItemRecord, "embedding">>; hasMore: boolean }> {
    const limit = Math.min(Math.max(pagination.limit ?? 50, 1), 200);
    const query: Record<string, unknown> = { tenantId, userId, status: "active", ...filter };
    if (pagination.before) query.updatedAt = { $lt: pagination.before };

    // Fetch one extra row to learn whether there's a next page without a second count query.
    const rows = await memoryItemsCollection()
      .find(query, { projection: { _id: 0, embedding: 0 } })
      .sort({ updatedAt: -1 })
      .limit(limit + 1)
      .toArray();

    return { items: rows.slice(0, limit) as Array<Omit<MemoryItemRecord, "embedding">>, hasMore: rows.length > limit };
  }

  /** Top items by importance (not recency) for a scope - what the profile/workspace summary
   * cards are built from, since a rarely-mentioned-but-important fact should outrank a recent
   * but trivial one. */
  async listTopItems(
    tenantId: string,
    userId: string,
    scope: MemoryItemRecord["scope"],
    workspaceId: string | null,
    limit: number,
  ): Promise<MemoryItemRecord[]> {
    return memoryItemsCollection()
      .find({ tenantId, userId, scope, workspaceId, status: "active" }, NO_ID_PROJECTION)
      .sort({ importance: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async deleteItemsBySourceEvent(sourceEventId: string): Promise<void> {
    await memoryItemsCollection().updateMany(
      { sourceEventIds: sourceEventId },
      { $set: { status: "deleted", updatedAt: new Date() } },
    );
  }

  /**
   * Thread deletion's source-aware cleanup: cancels/removes this thread's own memory_events
   * (nothing outstanding will ever be leased for a deleted thread again), then, for every item
   * that cited one of those events as a source, either strips just that source (the item still
   * has other sources - typically another turn in the same thread that's also being removed, or,
   * in a future cross-thread-consolidation world, a different thread) or - once no source remains
   * - marks the item itself deleted. Every change is still recorded via recordRevision so the
   * audit trail explains why an item disappeared.
   */
  async deleteEventsAndCleanupForThread(tenantId: string, userId: string, threadId: string): Promise<void> {
    const events = await memoryEventsCollection().find({ tenantId, userId, threadId }, { projection: { _id: 0, id: 1 } }).toArray();
    const eventIds = events.map((e) => e.id);
    if (eventIds.length === 0) return;

    await memoryEventsCollection().deleteMany({ id: { $in: eventIds } });

    const affected = await memoryItemsCollection()
      .find({ tenantId, userId, sourceEventIds: { $in: eventIds }, status: "active" }, NO_ID_PROJECTION)
      .toArray();

    for (const item of affected) {
      const remainingSources = item.sourceEventIds.filter((id) => !eventIds.includes(id));
      if (remainingSources.length === 0) {
        await memoryItemsCollection().updateOne({ id: item.id }, { $set: { status: "deleted", updatedAt: new Date() } });
        await this.recordRevision({
          tenantId,
          userId,
          itemId: item.id,
          action: "source_removed",
          actorType: "user",
          actorId: userId,
          before: item,
          after: null,
          reason: `thread ${threadId} deleted`,
        });
      } else {
        await memoryItemsCollection().updateOne(
          { id: item.id },
          { $set: { sourceEventIds: remainingSources, updatedAt: new Date() } },
        );
      }
    }
  }

  /** Workspace deletion: purges workspace-scoped items/summaries only - never touches the threads
   * themselves (callers separately unassign threads via setThreadWorkspace/unassignWorkspaceFromThreads). */
  async purgeWorkspace(tenantId: string, workspaceId: string): Promise<void> {
    const items = await memoryItemsCollection().find({ tenantId, workspaceId, status: "active" }, NO_ID_PROJECTION).toArray();
    for (const item of items) {
      await this.softDeleteItem(tenantId, item.userId, item, `workspace ${workspaceId} deleted`);
    }
    await memorySummariesCollection().deleteMany({ tenantId, scope: "workspace", scopeRef: workspaceId });
  }

  // --- memory_revisions ------------------------------------------------------------------------

  /** Append-only. Takes an object rather than positional arguments because the actor fields made
   * an already-long parameter list easy to mis-order silently. */
  async recordRevision(input: {
    tenantId: string;
    userId: string;
    /** Null only for "rejected", where no item was ever created. */
    itemId: string | null;
    action: MemoryRevisionAction;
    actorType: MemoryActorType;
    actorId: string;
    before?: Partial<MemoryItemRecord> | null;
    after?: Partial<MemoryItemRecord> | null;
    reason?: string | null;
  }): Promise<void> {
    await memoryRevisionsCollection().insertOne({
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      itemId: input.itemId,
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason ?? null,
      createdAt: new Date(),
    });
  }

  /**
   * Records a candidate the policy gate refused, so a rejection is reviewable instead of vanishing.
   * `itemId` is null because nothing was written; the candidate itself goes in `after` so an
   * operator can see what was proposed and why it was blocked.
   */
  async recordRejection(
    tenantId: string,
    userId: string,
    candidate: Pick<MemoryItemRecord, "subject" | "predicate" | "object" | "content" | "canonicalKey" | "confidence">,
    reason: string,
  ): Promise<void> {
    await this.recordRevision({
      tenantId,
      userId,
      itemId: null,
      action: "rejected",
      actorType: "worker",
      actorId: userId,
      before: null,
      after: candidate,
      reason,
    });
  }

  // --- memory_summaries ------------------------------------------------------------------------

  async getSummary(
    tenantId: string,
    userId: string,
    scope: MemorySummaryRecord["scope"],
    scopeRef: string | null,
  ): Promise<MemorySummaryRecord | null> {
    return memorySummariesCollection().findOne({ tenantId, userId, scope, scopeRef }, NO_ID_PROJECTION);
  }

  async upsertSummary(summary: Omit<MemorySummaryRecord, "id" | "updatedAt">): Promise<void> {
    await memorySummariesCollection().updateOne(
      { tenantId: summary.tenantId, userId: summary.userId, scope: summary.scope, scopeRef: summary.scopeRef },
      {
        $set: { ...summary, updatedAt: new Date() },
        $setOnInsert: { id: randomUUID() },
      },
      { upsert: true },
    );
  }

  // --- memory_worker_locks ---------------------------------------------------------------------

  /** True if this call acquired (or already held) the lease; false if another owner holds a
   * still-live lease. Insert-then-catch-duplicate-key, same pattern as claimOrVerifyThreadOwnership. */
  async acquireLock(
    tenantId: string,
    userId: string,
    threadId: string | null,
    ownerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);
    try {
      await memoryWorkerLocksCollection().insertOne({
        id: randomUUID(),
        tenantId,
        userId,
        threadId,
        ownerId,
        acquiredAt: now,
        expiresAt,
      });
      return true;
    } catch {
      const result = await memoryWorkerLocksCollection().updateOne(
        { tenantId, userId, threadId, $or: [{ expiresAt: { $lt: now } }, { ownerId }] },
        { $set: { ownerId, acquiredAt: now, expiresAt } },
      );
      return result.modifiedCount > 0;
    }
  }

  async releaseLock(tenantId: string, userId: string, threadId: string | null, ownerId: string): Promise<void> {
    await memoryWorkerLocksCollection().deleteOne({ tenantId, userId, threadId, ownerId });
  }
}

export const memoryRepository = new MemoryRepository();
