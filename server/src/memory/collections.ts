import { getDb } from "../db.js";
import type {
  GoalRecord,
  MemoryEventRecord,
  MemoryItemRecord,
  MemoryRevisionRecord,
  MemorySummaryRecord,
  MemoryWorkerLockRecord,
  ThreadRecord,
  UserMemorySettingsRecord,
  WorkspaceRecord,
} from "./types.js";

/** Shared by every read path across this repo's Mongo access layers (repository.ts,
 * workspaceService.ts, goalService.ts) that never needs the raw `_id`. */
export const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

export function goalsCollection() {
  return getDb().collection<GoalRecord>("goals");
}

export function threadsCollection() {
  return getDb().collection<ThreadRecord>("threads");
}

// ---------------------------------------------------------------------------
// Memory v2 collections (see PLAN.md / types.ts's "Memory v2" section).
// ---------------------------------------------------------------------------

export function workspacesCollection() {
  return getDb().collection<WorkspaceRecord>("workspaces");
}

export function memoryEventsCollection() {
  return getDb().collection<MemoryEventRecord>("memory_events");
}

export function memoryItemsCollection() {
  return getDb().collection<MemoryItemRecord>("memory_items");
}

export function memorySummariesCollection() {
  return getDb().collection<MemorySummaryRecord>("memory_summaries");
}

export function memoryRevisionsCollection() {
  return getDb().collection<MemoryRevisionRecord>("memory_revisions");
}

export function memoryWorkerLocksCollection() {
  return getDb().collection<MemoryWorkerLockRecord>("memory_worker_locks");
}

export function userMemorySettingsCollection() {
  return getDb().collection<UserMemorySettingsRecord>("user_memory_settings");
}

export async function ensureGoalIndexes(): Promise<void> {
  await goalsCollection().createIndex({ tenantId: 1, userId: 1, status: 1, createdAt: -1 });
  await goalsCollection().createIndex({ tenantId: 1, threadId: 1 });
}

/**
 * _id (the threadId itself) already gives ownership-claim uniqueness for free - no separate
 * unique-compound-index is needed the way thread_owners required. The partial unique index below
 * is what replaces default_thread_pointers: at most one isDefault:true document per
 * (tenantId, userId), enforced the same insert-then-catch-duplicate-key way
 * claimOrVerifyThreadOwnership always worked.
 */
export async function ensureThreadIndexes(): Promise<void> {
  await threadsCollection().createIndex({ tenantId: 1, userId: 1, createdAt: -1 });
  await threadsCollection().createIndex(
    { tenantId: 1, userId: 1, isDefault: 1 },
    { unique: true, partialFilterExpression: { isDefault: true } },
  );
  await threadsCollection().createIndex({ tenantId: 1, workspaceId: 1 });
  await threadsCollection().createIndex({ memoryMode: 1, updatedAt: 1 });
}

/**
 * Ordinary (non-Atlas-Search) indexes only, per PLAN.md's split: these support the worker's
 * lease/retry/status queries and the retrieval path's non-vector filters. The Atlas Search and
 * Vector Search indexes (memory-items-vector, memory-items-text) are a privileged, separate
 * deployment step - see scripts/provisionMemoryIndexes.ts and `npm run memory:provision-indexes`.
 */
export async function ensureMemoryV2Indexes(): Promise<void> {
  await workspacesCollection().createIndex({ tenantId: 1, userId: 1, createdAt: -1 });

  // Two indexes for the eligibility filter's two $or branches: a lease-expired "processing" event
  // (reclaimed from a crashed worker) matches the first; a backoff-gated "pending" one matches the
  // second. tenantId leads both, matching findEligibleGroup/leaseEventsForGroup's own $match shape.
  await memoryEventsCollection().createIndex({ tenantId: 1, status: 1, leaseExpiresAt: 1 });
  await memoryEventsCollection().createIndex({ tenantId: 1, status: 1, nextAttemptAt: 1 });
  await memoryEventsCollection().createIndex({ tenantId: 1, userId: 1, threadId: 1, createdAt: 1 });
  await memoryEventsCollection().createIndex({ turnId: 1 }, { unique: true });

  await memoryItemsCollection().createIndex({ tenantId: 1, userId: 1, scope: 1, canonicalKey: 1, status: 1 });
  await memoryItemsCollection().createIndex({ tenantId: 1, scope: 1, workspaceId: 1, status: 1 });
  // Matches listTopItems/deleteItemsByScope's actual filter shape ({tenantId,userId,scope,
  // workspaceId,status}) - neither index above covers userId+workspaceId together, so that query
  // was falling back to a much less selective index scan.
  await memoryItemsCollection().createIndex({ tenantId: 1, userId: 1, scope: 1, workspaceId: 1, status: 1, importance: -1 });
  // Taxonomy filters: subtype is included because retrieval and the memories API both filter by
  // the narrower category (a preference vs a fact), not just the kind.
  await memoryItemsCollection().createIndex({ tenantId: 1, userId: 1, kind: 1, subtype: 1, status: 1 });
  await memoryItemsCollection().createIndex({ sourceEventIds: 1 });
  await memoryItemsCollection().createIndex({ embeddingStatus: 1 });
  // Drives the worker's lifecycle sweep, whose filter is {status, validTo} - status first because
  // it is the more selective of the two once most items have settled.
  await memoryItemsCollection().createIndex({ status: 1, validTo: 1 });
  // Version-chain walks: "show me every revision of this canonical key" and supersession lookups.
  await memoryItemsCollection().createIndex({ tenantId: 1, userId: 1, canonicalKey: 1, version: -1 });
  await memoryItemsCollection().createIndex({ supersededBy: 1 }, { sparse: true });

  await memorySummariesCollection().createIndex(
    { tenantId: 1, userId: 1, scope: 1, scopeRef: 1 },
    { unique: true },
  );

  await memoryRevisionsCollection().createIndex({ tenantId: 1, userId: 1, itemId: 1, createdAt: 1 });
  // Rejected candidates carry itemId: null, so they are only reachable by action - this is what
  // makes "what did the policy gate refuse for this user?" answerable.
  await memoryRevisionsCollection().createIndex({ tenantId: 1, userId: 1, action: 1, createdAt: -1 });

  await memoryWorkerLocksCollection().createIndex(
    { tenantId: 1, userId: 1, threadId: 1 },
    { unique: true },
  );
  await memoryWorkerLocksCollection().createIndex({ expiresAt: 1 });

  await userMemorySettingsCollection().createIndex({ tenantId: 1, userId: 1 }, { unique: true });
}
