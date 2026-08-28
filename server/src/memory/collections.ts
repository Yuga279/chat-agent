import { getDb } from "../db.js";
import type {
  ConversationMessageRecord,
  EpisodeRecord,
  GoalRecord,
  MemoryEventRecord,
  MemoryItemRecord,
  MemoryRevisionRecord,
  MemorySummaryRecord,
  MemoryWorkerLockRecord,
  SemanticMemoryRecord,
  ThreadRecord,
  UserMemorySettingsRecord,
  WorkspaceRecord,
} from "./types.js";

export function conversationMessagesCollection() {
  return getDb().collection<ConversationMessageRecord>("conversation_messages");
}

export function semanticMemoriesCollection() {
  return getDb().collection<SemanticMemoryRecord>("semantic_memories");
}

export function episodesCollection() {
  return getDb().collection<EpisodeRecord>("episodes");
}

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

export async function ensureMemoryIndexes(): Promise<void> {
  await conversationMessagesCollection().createIndex({ sessionId: 1, createdAt: 1 });
  await conversationMessagesCollection().createIndex({ tenantId: 1, userId: 1, threadId: 1, createdAt: 1 });

  await semanticMemoriesCollection().createIndex({ tenantId: 1, userId: 1, subject: 1, predicate: 1, status: 1 });
  await semanticMemoriesCollection().createIndex({ tenantId: 1, userId: 1, type: 1, status: 1 });
  await semanticMemoriesCollection().createIndex({ tenantId: 1, scope: 1, status: 1 });

  await episodesCollection().createIndex({ tenantId: 1, userId: 1, task: 1 });
  await episodesCollection().createIndex({ tenantId: 1, userId: 1, threadId: 1 });
  await episodesCollection().createIndex({ tenantId: 1, userId: 1, goalId: 1 });

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

  await memoryEventsCollection().createIndex({ status: 1, leaseExpiresAt: 1 });
  await memoryEventsCollection().createIndex({ tenantId: 1, userId: 1, threadId: 1, createdAt: 1 });
  await memoryEventsCollection().createIndex({ turnId: 1 }, { unique: true });

  await memoryItemsCollection().createIndex({ tenantId: 1, userId: 1, scope: 1, canonicalKey: 1, status: 1 });
  await memoryItemsCollection().createIndex({ tenantId: 1, scope: 1, workspaceId: 1, status: 1 });
  await memoryItemsCollection().createIndex({ tenantId: 1, userId: 1, kind: 1, status: 1 });
  await memoryItemsCollection().createIndex({ sourceEventIds: 1 });
  await memoryItemsCollection().createIndex({ embeddingStatus: 1 });
  await memoryItemsCollection().createIndex({ validTo: 1 });

  await memorySummariesCollection().createIndex(
    { tenantId: 1, userId: 1, scope: 1, scopeRef: 1 },
    { unique: true },
  );

  await memoryRevisionsCollection().createIndex({ tenantId: 1, userId: 1, itemId: 1, createdAt: 1 });

  await memoryWorkerLocksCollection().createIndex(
    { tenantId: 1, userId: 1, threadId: 1 },
    { unique: true },
  );
  await memoryWorkerLocksCollection().createIndex({ expiresAt: 1 });

  await userMemorySettingsCollection().createIndex({ tenantId: 1, userId: 1 }, { unique: true });
}
