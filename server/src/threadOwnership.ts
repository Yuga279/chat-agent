import crypto from "node:crypto";
import { threadsCollection } from "./memory/collections.js";
import { DEFAULT_TENANT_ID } from "./constants.js";
import type { ThreadRecord } from "./memory/types.js";

/**
 * Security §18: a client-supplied threadId must not let one user read/continue another user's
 * conversation. The first caller to use a threadId claims it for that userId; every later call
 * must match. `_id` (the threadId itself) is what makes this safe under concurrent first-uses of
 * the same threadId racing for different users - Mongo's own _id uniqueness does the job that
 * used to require a separate (tenantId, threadId) compound unique index on a thread_owners
 * collection.
 */
export async function claimOrVerifyThreadOwnership(
  threadId: string,
  userId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  const now = new Date();
  try {
    await threadsCollection().insertOne({
      _id: threadId,
      tenantId,
      userId,
      status: "active",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  } catch {
    // Duplicate key - someone already claimed this thread. Legitimate on every resumed run; only
    // a problem if it belongs to a different user (or, once a second tenant exists, a different tenant).
    const existing = await threadsCollection().findOne({ _id: threadId, tenantId });
    return existing?.userId === userId;
  }
}

export async function listThreadsForUser(userId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ThreadRecord[]> {
  return threadsCollection()
    .find({ tenantId, userId })
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Returns this user's one default thread, creating it atomically on first call and returning the
 * same one on every later call - regardless of how many callers race here concurrently. Same
 * insert-then-catch-duplicate-key pattern as claimOrVerifyThreadOwnership: only one concurrent
 * insert can win the partial unique (tenantId, userId, isDefault: true) index, so every loser just
 * reads back the winner's threadId instead of also creating a thread of its own.
 */
export async function ensureDefaultThreadId(userId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const candidateThreadId = crypto.randomUUID();
  const now = new Date();
  try {
    await threadsCollection().insertOne({
      _id: candidateThreadId,
      tenantId,
      userId,
      status: "active",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    return candidateThreadId;
  } catch {
    const existing = await threadsCollection().findOne({ tenantId, userId, isDefault: true });
    if (existing) return existing._id;
    throw new Error("Failed to ensure default thread: no default found after insert conflict");
  }
}

/**
 * Removes a thread from this user's records entirely. Returns false if the thread doesn't exist
 * or belongs to someone else, so the route layer can 404/403 instead of silently no-op'ing.
 */
export async function deleteThreadOwnership(
  threadId: string,
  userId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  const result = await threadsCollection().deleteOne({ _id: threadId, tenantId, userId });
  return result.deletedCount > 0;
}

export async function renameThread(
  threadId: string,
  userId: string,
  title: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  const result = await threadsCollection().updateOne(
    { _id: threadId, tenantId, userId },
    { $set: { title, updatedAt: new Date() } },
  );
  return result.matchedCount > 0;
}
