import { randomUUID } from "node:crypto";
import { workspacesCollection } from "../collections.js";
import type { WorkspaceRecord } from "../types.js";

const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

/** User-owned chat workspaces - CRUD only, no membership/sharing model (single-user-per-workspace
 * today, per PLAN.md's scope). */
export class WorkspaceService {
  async create(tenantId: string, userId: string, name: string): Promise<WorkspaceRecord> {
    const now = new Date();
    const record: WorkspaceRecord = { id: randomUUID(), tenantId, userId, name, createdAt: now, updatedAt: now };
    await workspacesCollection().insertOne(record);
    return record;
  }

  async list(tenantId: string, userId: string): Promise<WorkspaceRecord[]> {
    return workspacesCollection().find({ tenantId, userId }, NO_ID_PROJECTION).sort({ createdAt: -1 }).toArray();
  }

  async rename(tenantId: string, userId: string, id: string, name: string): Promise<boolean> {
    const result = await workspacesCollection().updateOne({ id, tenantId, userId }, { $set: { name, updatedAt: new Date() } });
    return result.matchedCount > 0;
  }

  async getOwned(tenantId: string, userId: string, id: string): Promise<WorkspaceRecord | null> {
    return workspacesCollection().findOne({ id, tenantId, userId }, NO_ID_PROJECTION);
  }

  async delete(tenantId: string, userId: string, id: string): Promise<boolean> {
    const result = await workspacesCollection().deleteOne({ id, tenantId, userId });
    return result.deletedCount > 0;
  }
}

export const workspaceService = new WorkspaceService();
