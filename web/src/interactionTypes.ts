export interface ResearchPlanStep {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  order: number;
}

export interface ResearchPlanState {
  version: number;
  steps: ResearchPlanStep[];
}

export interface AgentAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
}

export interface AgentOption {
  id: string;
  label: string;
  description?: string;
}

export type AgentInteraction =
  | { type: "approval"; id: string; title: string; message: string; actions: AgentAction[] }
  | { type: "question"; id: string; question: string; options: AgentOption[]; allowCustomInput: boolean }
  | { type: "plan_edit"; id: string; plan: ResearchPlanState };
