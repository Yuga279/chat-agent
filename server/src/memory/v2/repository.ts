import { randomUUID } from "node:crypto";
import {
  memoryEventsCollection,
  memoryItemsCollection,
  memoryRevisionsCollection,
  memorySummariesCollection,
  memoryWorkerLocksCollection,
} from "../collections.js";
import type { MemoryEventRecord, MemoryItemRecord, MemoryRevisionAction } from "../types.js";

const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

/**
 * Thin Mongo access layer for the v2 collections - MemoryWorker/MemoryConsolidator/MemoryRetriever
 * go through this rather than calling collections.ts directly, so the storage shape can change
 * without touching worker logic. MemoryService remains the narrow facade the graph/routes use;
 * this repository is v2-internal.
 */
export class MemoryRepository {
  // --- memory_events (outbox) ---------------------------------------------------------------

  async enqueueEvent(
    event: Omit<MemoryEventRecord, "id" | "status" | "attempts" | "lastError" | "leaseOwner" | "leaseExpiresAt" | "createdAt" | "updatedAt">,
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
      createdAt: now,
      updatedAt: now,
    };
    await memoryEventsCollection().insertOne(record);
    return record;
  }

  /** Finds one user/thread group with a pending batch ready to process: at least `minTurns`
   * pending events, or an oldest pending event older than `maxAgeMs`. Returns null when nothing
   * is eligible yet (there may be pending events, just not enough of them / not old enough). */
  async findEligibleGroup(
    minTurns: number,
    maxAgeMs: number,
  ): Promise<{ userId: string; threadId: string } | null> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const now = new Date();
    const groups = await memoryEventsCollection()
      .aggregate<{ _id: { userId: string; threadId: string }; count: number; oldest: Date }>([
        {
          $match: {
            status: "pending",
            $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }],
          },
        },
        { $group: { _id: { userId: "$userId", threadId: "$threadId" }, count: { $sum: 1 }, oldest: { $min: "$createdAt" } } },
        { $match: { $or: [{ count: { $gte: minTurns } }, { oldest: { $lte: cutoff } }] } },
        { $sort: { oldest: 1 } },
        { $limit: 1 },
      ])
      .toArray();
    const group = groups[0];
    return group ? { userId: group._id.userId, threadId: group._id.threadId } : null;
  }

  /** Atomically leases up to `limit` pending (or lease-expired) events for one user/thread pair,
   * oldest first - the unit of work a single processBatch() call processes together. */
  async leaseEventsForGroup(
    userId: string,
    threadId: string,
    ownerId: string,
    leaseMs: number,
    limit: number,
  ): Promise<MemoryEventRecord[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const filter = {
      userId,
      threadId,
      status: "pending" as const,
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }],
    };
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
  }

  /** Reverts a lease on failure: back to "pending" with an incremented attempt count, or "dead"
   * once attempts is exhausted (never retried again, but left in place for inspection). */
  async failEvent(id: string, error: string, maxAttempts: number): Promise<void> {
    const event = await memoryEventsCollection().findOne({ id }, NO_ID_PROJECTION);
    if (!event) return;
    const attempts = event.attempts + 1;
    await memoryEventsCollection().updateOne(
      { id },
      {
        $set: {
          status: attempts >= maxAttempts ? "dead" : "pending",
          attempts,
          lastError: error,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      },
    );
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

  async supersedeItem(oldId: string, newId: string): Promise<void> {
    await memoryItemsCollection().updateOne(
      { id: oldId },
      { $set: { status: "superseded", supersedes: newId, updatedAt: new Date() } },
    );
  }

  async deleteItem(id: string): Promise<void> {
    await memoryItemsCollection().updateOne({ id }, { $set: { status: "deleted", updatedAt: new Date() } });
  }

  async setEmbedding(id: string, embedding: number[] | null): Promise<void> {
    await memoryItemsCollection().updateOne(
      { id },
      {
        $set: {
          embedding,
          embeddingStatus: embedding ? "done" : "failed",
          updatedAt: new Date(),
        },
      },
    );
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
    await this.recordRevision(tenantId, userId, id, "manual_edit", before, after, "user edit via /api/memories");
    return after;
  }

  async deleteOwnedItem(tenantId: string, userId: string, id: string): Promise<boolean> {
    const before = await this.getOwnedItem(tenantId, userId, id);
    if (!before) return false;
    await memoryItemsCollection().updateOne({ id, tenantId, userId }, { $set: { status: "deleted", updatedAt: new Date() } });
    await this.recordRevision(tenantId, userId, id, "deleted", before, null, "user delete via /api/memories");
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
      await memoryItemsCollection().updateOne({ id: item.id }, { $set: { status: "deleted", updatedAt: new Date() } });
      await this.recordRevision(tenantId, userId, item.id, "deleted", item, null, "user clear-all via /api/memories");
    }
    return items.length;
  }

  async listItems(
    tenantId: string,
    userId: string,
    filter: { scope?: MemoryItemRecord["scope"]; workspaceId?: string | null } = {},
  ): Promise<MemoryItemRecord[]> {
    return memoryItemsCollection()
      .find({ tenantId, userId, status: "active", ...filter }, NO_ID_PROJECTION)
      .sort({ updatedAt: -1 })
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
        await this.recordRevision(tenantId, userId, item.id, "source_removed", item, null, `thread ${threadId} deleted`);
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
      await memoryItemsCollection().updateOne({ id: item.id }, { $set: { status: "deleted", updatedAt: new Date() } });
      await this.recordRevision(tenantId, item.userId, item.id, "deleted", item, null, `workspace ${workspaceId} deleted`);
    }
    await memorySummariesCollection().deleteMany({ tenantId, scope: "workspace", scopeRef: workspaceId });
  }

  // --- memory_revisions ------------------------------------------------------------------------

  async recordRevision(
    tenantId: string,
    userId: string,
    itemId: string,
    action: MemoryRevisionAction,
    before: Partial<MemoryItemRecord> | null,
    after: Partial<MemoryItemRecord> | null,
    reason: string | null = null,
  ): Promise<void> {
    await memoryRevisionsCollection().insertOne({
      id: randomUUID(),
      tenantId,
      userId,
      itemId,
      action,
      before,
      after,
      reason,
      createdAt: new Date(),
    });
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
