import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import type { ResearchPlanState, ResearchPlanStep } from "./interactionTypes.js";

const STATUS_ICON: Record<ResearchPlanStep["status"], string> = {
  pending: "○",
  running: "⟳",
  completed: "✓",
  failed: "✗",
  skipped: "⊘",
};

export default function ResearchPlan() {
  const { agent } = useAgent({
    agentId: "research",
    updates: [UseAgentUpdate.OnStateChanged],
  });

  const plan = (agent.state as { plan?: ResearchPlanState | null } | undefined)?.plan;
  if (!plan || plan.steps.length === 0) return null;

  const steps = [...plan.steps].sort((a, b) => a.order - b.order);

  return (
    <div className="research-plan">
      <h2>Research Plan</h2>
      <ol>
        {steps.map((step) => (
          <li key={step.id} className={`plan-step plan-step--${step.status}`}>
            <span className="plan-step__icon">{STATUS_ICON[step.status]}</span>
            <span className="plan-step__title">{step.title}</span>
            {step.description && <p className="plan-step__description">{step.description}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
