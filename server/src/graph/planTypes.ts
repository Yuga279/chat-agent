export interface ResearchPlanStep {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  order: number;
}

export interface ResearchPlan {
  version: number;
  steps: ResearchPlanStep[];
}
