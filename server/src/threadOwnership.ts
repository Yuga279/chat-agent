import crypto from "node:crypto";
import { getDb } from "./db.js";
import { DEFAULT_TENANT_ID } from "./constants.js";

interface ThreadOwnerRecord {
  tenantId: string;
  threadId: string;
  userId: string;
  createdAt: string;
  title?: string;
}

interface DefaultThreadPointerRecord {
  tenantId: string;
  userId: string;
  threadId: string;
  createdAt: string;
}

function threadOwnersCollection() {
  return getDb().collection<ThreadOwnerRecord>("thread_owners");
}

function defaultThreadPointersCollection() {
  return getDb().collection<DefaultThreadPointerRecord>("default_thread_pointers");
}

/**
 * Compound (tenantId, threadId), not threadId alone: uniqueness is scoped per tenant so a
 * threadId collision across two different tenants (astronomically unlikely with uuids, but not
 * architecturally impossible) can't false-positive as an ownership conflict once a second tenant
 * exists.
 */
export async function ensureThreadOwnershipIndexes(): Promise<void> {
  await threadOwnersCollection().createIndex({ tenantId: 1, threadId: 1 }, { unique: true });
  await threadOwnersCollection().createIndex({ tenantId: 1, userId: 1, createdAt: -1 });
  // One default-thread pointer per (tenantId, userId) - what makes ensureDefaultThreadId() below
  // safe under concurrent callers (double effect-fire, multiple tabs, StrictMode) instead of
  // relying on a client-side "if the list looked empty, create one" race that let the same user
  // end up with many auto-created empty threads in practice.
  await defaultThreadPointersCollection().createIndex({ tenantId: 1, userId: 1 }, { unique: true });
}

/**
 * Security §18: a client-supplied threadId must not let one user read/continue another user's
 * conversation. The first caller to use a threadId claims it for that userId; every later call
 * must match. The unique index (not a read-then-write check) is what makes this safe under
 * concurrent first-uses of the same threadId racing for different users.
 */
export async function claimOrVerifyThreadOwnership(
  threadId: string,
  userId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  try {
    await threadOwnersCollection().insertOne({ tenantId, threadId, userId, createdAt: new Date().toISOString() });
    return true;
  } catch {
    // Duplicate key - someone already claimed this thread. Legitimate on every resumed run; only
    // a problem if it belongs to a different user (or, once a second tenant exists, a different tenant).
    const existing = await threadOwnersCollection().findOne({ tenantId, threadId });
    return existing?.userId === userId;
  }
}

export async function listThreadsForUser(userId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ThreadOwnerRecord[]> {
  return threadOwnersCollection()
    .find({ tenantId, userId })
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Returns this user's one default thread, creating it atomically on first call and returning the
 * same one on every later call - regardless of how many callers race here concurrently. Same
 * insert-then-catch-duplicate-key pattern as claimOrVerifyThreadOwnership: only one concurrent
 * insert into default_thread_pointers can win the unique (tenantId, userId) index, so every loser
 * just reads back the winner's threadId instead of also creating a thread of its own.
 */
export async function ensureDefaultThreadId(userId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const candidateThreadId = crypto.randomUUID();
  try {
    await defaultThreadPointersCollection().insertOne({
      tenantId,
      userId,
      threadId: candidateThreadId,
      createdAt: new Date().toISOString(),
    });
  } catch {
    const existing = await defaultThreadPointersCollection().findOne({ tenantId, userId });
    if (existing) return existing.threadId;
    throw new Error("Failed to ensure default thread: no pointer found after insert conflict");
  }

  await claimOrVerifyThreadOwnership(candidateThreadId, userId, tenantId);
  return candidateThreadId;
}

/**
 * Removes a thread from this user's records entirely: the ownership row, and the default-thread
 * pointer if this happened to be that user's default (otherwise a deleted thread would stay
 * "sticky" as their auto-selected default forever). Returns false if the thread doesn't exist or
 * belongs to someone else, so the route layer can 404/403 instead of silently no-op'ing.
 */
export async function deleteThreadOwnership(
  threadId: string,
  userId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  const result = await threadOwnersCollection().deleteOne({ tenantId, threadId, userId });
  if (result.deletedCount === 0) return false;

  await defaultThreadPointersCollection().deleteOne({ tenantId, userId, threadId });
  return true;
}

export async function renameThread(
  threadId: string,
  userId: string,
  title: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  const result = await threadOwnersCollection().updateOne({ tenantId, threadId, userId }, { $set: { title } });
  return result.matchedCount > 0;
}
