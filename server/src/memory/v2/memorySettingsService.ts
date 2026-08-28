import { userMemorySettingsCollection } from "../collections.js";

/** Defaults to enabled for any user with no row yet - opt-out, not opt-in, matching today's
 * behavior where memory has always been on. */
export async function isMemoryEnabledForUser(tenantId: string, userId: string): Promise<boolean> {
  const settings = await userMemorySettingsCollection().findOne({ tenantId, userId }, { projection: { _id: 0, enabled: 1 } });
  return settings?.enabled ?? true;
}

export async function setMemoryEnabledForUser(tenantId: string, userId: string, enabled: boolean): Promise<void> {
  await userMemorySettingsCollection().updateOne(
    { tenantId, userId },
    { $set: { enabled, updatedAt: new Date() }, $setOnInsert: { tenantId, userId } },
    { upsert: true },
  );
}
