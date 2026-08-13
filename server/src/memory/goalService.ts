import { randomUUID } from "node:crypto";
import { goalsCollection } from "./collections.js";
import type { GoalRecord, GoalStep } from "./types.js";

const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

/**
 * Backs assistantGraph.ts's durable, cross-turn goal tracking: a multi-step plan is persisted
 * here as soon as it's proposed, so it survives a server restart or a brand-new thread, not just
 * the lifetime of one LangGraph run's in-memory state. Only one proposed/active goal per user is
 * expected at a time - assistantGraph's checkGoalNode looks one up before ever asking the planner
 * to make a fresh decision.
 */
export class GoalService {
  async proposeGoal(
    tenantId: string,
    userId: string,
    title: string,
    steps: Array<{ title: string; description?: string }>,
  ): Promise<GoalRecord> {
    const now = new Date().toISOString();
    const goal: GoalRecord = {
      id: randomUUID(),
      tenantId,
      userId,
      title,
      status: "proposed",
      steps: steps.map((s): GoalStep => ({ title: s.title, description: s.description, status: "pending" })),
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
    await goalsCollection().insertOne(goal);
    return goal;
  }

  async getProposedGoal(tenantId: string, userId: string): Promise<GoalRecord | null> {
    return goalsCollection().findOne({ tenantId, userId, status: "proposed" }, NO_ID_PROJECTION);
  }

  async getActiveGoal(tenantId: string, userId: string): Promise<GoalRecord | null> {
    return goalsCollection().findOne({ tenantId, userId, status: "active" }, NO_ID_PROJECTION);
  }

  async getGoalById(id: string): Promise<GoalRecord | null> {
    return goalsCollection().findOne({ id }, NO_ID_PROJECTION);
  }

  async updateSteps(id: string, steps: Array<{ title: string; description?: string }>): Promise<GoalRecord | null> {
    await goalsCollection().updateOne(
      { id },
      { $set: { steps: steps.map((s): GoalStep => ({ title: s.title, description: s.description, status: "pending" })), currentStepIndex: 0, updatedAt: new Date().toISOString() } },
    );
    return this.getGoalById(id);
  }

  async approveGoal(id: string): Promise<GoalRecord | null> {
    await goalsCollection().updateOne({ id }, { $set: { status: "active", updatedAt: new Date().toISOString() } });
    return this.getGoalById(id);
  }

  async abandonGoal(id: string): Promise<void> {
    await goalsCollection().updateOne({ id }, { $set: { status: "abandoned", updatedAt: new Date().toISOString() } });
  }

  /** Marks the goal's current step done and advances to the next one; marks the whole goal
   * "done" once the last step is complete. */
  async completeCurrentStep(id: string): Promise<GoalRecord | null> {
    const goal = await this.getGoalById(id);
    if (!goal) return null;

    const steps = goal.steps.map((s, i) => (i === goal.currentStepIndex ? { ...s, status: "done" as const } : s));
    const nextIndex = goal.currentStepIndex + 1;
    const done = nextIndex >= steps.length;

    await goalsCollection().updateOne(
      { id },
      { $set: { steps, currentStepIndex: nextIndex, status: done ? "done" : "active", updatedAt: new Date().toISOString() } },
    );
    return this.getGoalById(id);
  }

  async listActiveGoals(tenantId: string, userId: string, limit = 5): Promise<GoalRecord[]> {
    return goalsCollection().find({ tenantId, userId, status: "active" }, NO_ID_PROJECTION).sort({ createdAt: -1 }).limit(limit).toArray();
  }
}

export const goalService = new GoalService();
