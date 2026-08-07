import { getDb } from "../db.js";
import type { ConversationMessageRecord, EpisodeRecord, GoalRecord, MemoryRecord } from "./types.js";

export function conversationMessagesCollection() {
  return getDb().collection<ConversationMessageRecord>("conversation_messages");
}

export function memoriesCollection() {
  return getDb().collection<MemoryRecord>("memories");
}

export function episodesCollection() {
  return getDb().collection<EpisodeRecord>("episodes");
}

export function goalsCollection() {
  return getDb().collection<GoalRecord>("goals");
}

export async function ensureMemoryIndexes(): Promise<void> {
  await conversationMessagesCollection().createIndex({ sessionId: 1, createdAt: 1 });
  await memoriesCollection().createIndex({ tenantId: 1, userId: 1, subject: 1, predicate: 1, status: 1 });
  await memoriesCollection().createIndex({ tenantId: 1, userId: 1, type: 1, status: 1 });
  await episodesCollection().createIndex({ tenantId: 1, userId: 1, task: 1 });
  await goalsCollection().createIndex({ tenantId: 1, userId: 1, status: 1, createdAt: -1 });
}
