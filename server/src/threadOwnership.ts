import { getDb } from "./db.js";

interface ThreadOwnerRecord {
  threadId: string;
  externalUserId: string;
  createdAt: string;
}

function threadOwnersCollection() {
  return getDb().collection<ThreadOwnerRecord>("thread_owners");
}

export async function ensureThreadOwnershipIndexes(): Promise<void> {
  await threadOwnersCollection().createIndex({ threadId: 1 }, { unique: true });
}

/**
 * Security §18: a client-supplied threadId must not let one user read/continue another user's
 * conversation. The first caller to use a threadId claims it for that externalUserId; every
 * later call must match. The unique index (not a read-then-write check) is what makes this safe
 * under concurrent first-uses of the same threadId racing for different users.
 */
export async function claimOrVerifyThreadOwnership(threadId: string, externalUserId: string): Promise<boolean> {
  try {
    await threadOwnersCollection().insertOne({ threadId, externalUserId, createdAt: new Date().toISOString() });
    return true;
  } catch {
    // Duplicate key - someone already claimed this thread. Legitimate on every resumed run; only
    // a problem if it belongs to a different user.
    const existing = await threadOwnersCollection().findOne({ threadId });
    return existing?.externalUserId === externalUserId;
  }
}
