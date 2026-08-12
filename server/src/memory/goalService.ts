import { goalsCollection } from "./collections.js";
import type { GoalRecord } from "./types.js";

const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

/**
 * Read-only lookup backing the get_active_goals memory tool (shared by every agent on both
 * execution paths). The legacy REST/SSE path used to create/propose/approve/advance GoalRecords
 * here too - that machinery was removed along with that path, so nothing writes to the `goals`
 * collection anymore and this will always return an empty list until a new writer is added.
 */
export class GoalService {
  async listActiveGoals(tenantId: string, userId: string, limit = 5): Promise<GoalRecord[]> {
    return goalsCollection().find({ tenantId, userId, status: "active" }, NO_ID_PROJECTION).sort({ createdAt: -1 }).limit(limit).toArray();
  }
}

export const goalService = new GoalService();
