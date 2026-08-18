import { getDb } from "../db.js";
import type {
  ConversationMessageRecord,
  EpisodeRecord,
  GoalRecord,
  SemanticMemoryRecord,
  ThreadRecord,
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
}
