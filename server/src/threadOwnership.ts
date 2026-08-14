import { getDb } from "./db.js";
import { DEFAULT_TENANT_ID } from "./constants.js";

interface ThreadOwnerRecord {
  tenantId: string;
  threadId: string;
  userId: string;
  createdAt: string;
  title?: string;
}

function threadOwnersCollection() {
  return getDb().collection<ThreadOwnerRecord>("thread_owners");
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

export async function renameThread(
  threadId: string,
  userId: string,
  title: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<boolean> {
  const result = await threadOwnersCollection().updateOne({ tenantId, threadId, userId }, { $set: { title } });
  return result.matchedCount > 0;
}
