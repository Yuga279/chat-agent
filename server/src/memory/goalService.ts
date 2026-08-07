import { randomUUID } from "node:crypto";
import { goalsCollection } from "./collections.js";
import type { GoalRecord, GoalStep } from "./types.js";

const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

/** Manages persistent, multi-step goals that survive across turns and sessions. */
export class GoalService {
  async createGoal(tenantId: string, userId: string, title: string, steps: Array<Pick<GoalStep, "description" | "agent">>): Promise<GoalRecord> {
    const now = new Date().toISOString();
    const goal: GoalRecord = {
      id: randomUUID(),
      tenantId,
      userId,
      title,
      status: "active",
      steps: steps.map((s) => ({ ...s, status: "pending" })),
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    };

    await goalsCollection().insertOne(goal);
    return goal;
  }

  /** Most recently created active goal for a user, if any. */
  async getActiveGoal(tenantId: string, userId: string): Promise<GoalRecord | null> {
    return goalsCollection().findOne({ tenantId, userId, status: "active" }, { ...NO_ID_PROJECTION, sort: { createdAt: -1 } });
  }

  async listActiveGoals(tenantId: string, userId: string, limit = 5): Promise<GoalRecord[]> {
    return goalsCollection().find({ tenantId, userId, status: "active" }, NO_ID_PROJECTION).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  /** Marks the goal's current step done and advances to the next one; completes the goal once all steps are done. */
  async advanceCurrentStep(goalId: string): Promise<GoalRecord | null> {
    const goal = await goalsCollection().findOne({ id: goalId }, NO_ID_PROJECTION);
    if (!goal || goal.status !== "active") return goal;

    const steps = [...goal.steps];
    if (steps[goal.currentStepIndex]) {
      steps[goal.currentStepIndex] = { ...steps[goal.currentStepIndex], status: "done" };
    }

    const nextIndex = goal.currentStepIndex + 1;
    const status = nextIndex >= steps.length ? "done" : "active";
    const updatedAt = new Date().toISOString();

    await goalsCollection().updateOne({ id: goalId }, { $set: { steps, currentStepIndex: nextIndex, status, updatedAt } });
    return { ...goal, steps, currentStepIndex: nextIndex, status, updatedAt };
  }

  async abandonGoal(goalId: string): Promise<void> {
    await goalsCollection().updateOne({ id: goalId }, { $set: { status: "abandoned", updatedAt: new Date().toISOString() } });
  }
}

export const goalService = new GoalService();
