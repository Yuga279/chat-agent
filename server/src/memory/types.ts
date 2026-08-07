export type MemoryType = "semantic" | "preference" | "episode";

export type MemoryStatus = "active" | "superseded" | "archived" | "deleted";

export type MemorySource = "user" | "conversation" | "agent" | "system";

/** A durable fact/preference/episode, scoped to a user (tenant support left as a column for future multi-tenant use). */
export interface MemoryRecord {
  id: string;
  tenantId: string;
  userId: string;
  type: MemoryType;
  subject: string;
  predicate: string;
  object: string;
  content: string;
  source: MemorySource;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  supersedes: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface EpisodeRecord {
  id: string;
  tenantId: string;
  userId: string;
  task: string;
  outcome: string;
  success: boolean;
  failureReason: string | null;
  toolsUsed: string;
  createdAt: string;
  importance: number;
}

/** A candidate fact pulled from a message, before it becomes a MemoryRecord. */
export interface ExtractedFact {
  memoryType: MemoryType | "ignore";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  reason: string;
}

export interface IMemoryImportanceScorer {
  score(fact: ExtractedFact, opts: { explicitStatement: boolean }): number;
}

export interface IMemoryExtractor {
  extract(message: string): Promise<ExtractedFact[]>;
}

export type GoalStatus = "active" | "done" | "abandoned";
export type GoalStepStatus = "pending" | "done";

export interface GoalStep {
  description: string;
  agent: "clockwork" | "research" | "qna";
  status: GoalStepStatus;
}

/** A persistent, multi-step objective that survives across turns/sessions. */
export interface GoalRecord {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  status: GoalStatus;
  steps: GoalStep[];
  currentStepIndex: number;
  createdAt: string;
  updatedAt: string;
}
