import type { ResearchPlan } from "./planTypes.js";

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

/**
 * §7: one reusable interaction shape instead of a bespoke payload per case. Every interrupt()
 * call in researchGraph.ts sends one of these three variants; the resume value's shape is
 * documented next to each interrupt call site since it's specific to that variant.
 */
export type AgentInteraction =
  | { type: "approval"; id: string; title: string; message: string; actions: AgentAction[] }
  | { type: "question"; id: string; question: string; options: AgentOption[]; allowCustomInput: boolean }
  | { type: "plan_edit"; id: string; plan: ResearchPlan };
