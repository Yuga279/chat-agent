import { useState } from "react";
import { useInterrupt } from "@copilotkit/react-core/v2";
import type { AgentInteraction, ResearchPlanState, ResearchPlanStep } from "./interactionTypes.js";

type Resolve = (payload?: unknown) => void;

function ApprovalInteraction({ value, resolve }: { value: Extract<AgentInteraction, { type: "approval" }>; resolve: Resolve }) {
  return (
    <div className="interaction interaction--approval">
      <p className="interaction__title">{value.title}</p>
      <p>{value.message}</p>
      <div className="interaction__actions">
        {value.actions.map((action) => (
          <button
            key={action.id}
            className={`interaction__action interaction__action--${action.style ?? "secondary"}`}
            onClick={() => resolve({ decision: action.id })}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function QuestionInteraction({ value, resolve }: { value: Extract<AgentInteraction, { type: "question" }>; resolve: Resolve }) {
  const [customText, setCustomText] = useState("");

  return (
    <div className="interaction interaction--question">
      <p className="interaction__title">{value.question}</p>
      <div className="interaction__actions">
        {value.options.map((option) => (
          <button key={option.id} className="interaction__action interaction__action--secondary" onClick={() => resolve({ optionId: option.id })}>
            {option.label}
          </button>
        ))}
      </div>
      {value.allowCustomInput && (
        <form
          className="interaction__custom-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (customText.trim()) resolve({ customText: customText.trim() });
          }}
        >
          <input placeholder="Type your own answer..." value={customText} onChange={(e) => setCustomText(e.target.value)} />
          <button type="submit">Submit</button>
        </form>
      )}
    </div>
  );
}

function reorder(steps: ResearchPlanStep[], id: string, direction: -1 | 1): ResearchPlanStep[] {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((s) => s.id === id);
  const target = index + direction;
  if (target < 0 || target >= sorted.length) return steps;
  [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
  return sorted.map((s, i) => ({ ...s, order: i }));
}

function PlanEditInteraction({ value, resolve }: { value: Extract<AgentInteraction, { type: "plan_edit" }>; resolve: Resolve }) {
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState<ResearchPlanStep[]>([...value.plan.steps].sort((a, b) => a.order - b.order));

  function updateStep(id: string, patch: Partial<ResearchPlanStep>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeStep(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i })));
  }

  function addStep() {
    setSteps((prev) => [...prev, { id: crypto.randomUUID(), title: "New step", status: "pending", order: prev.length }]);
  }

  function toggleSkip(id: string) {
    const step = steps.find((s) => s.id === id);
    if (step) updateStep(id, { status: step.status === "skipped" ? "pending" : "skipped" });
  }

  function saveAndContinue() {
    const plan: ResearchPlanState = { ...value.plan, steps };
    resolve({ action: "update", plan });
  }

  return (
    <div className="interaction interaction--plan">
      <p className="interaction__title">Research Plan</p>
      <ol>
        {steps.map((step, index) => (
          <li key={step.id} className={`plan-editor-step plan-step--${step.status}`}>
            {editing ? (
              <div className="plan-editor-step__fields">
                <input value={step.title} onChange={(e) => updateStep(step.id, { title: e.target.value })} />
                <textarea
                  placeholder="Description (optional)"
                  value={step.description ?? ""}
                  onChange={(e) => updateStep(step.id, { description: e.target.value })}
                />
                <div className="plan-editor-step__controls">
                  <button type="button" onClick={() => setSteps((prev) => reorder(prev, step.id, -1))} disabled={index === 0}>
                    ↑
                  </button>
                  <button type="button" onClick={() => setSteps((prev) => reorder(prev, step.id, 1))} disabled={index === steps.length - 1}>
                    ↓
                  </button>
                  <button type="button" onClick={() => toggleSkip(step.id)}>
                    {step.status === "skipped" ? "Unskip" : "Skip"}
                  </button>
                  <button type="button" onClick={() => removeStep(step.id)}>
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span>{step.title}</span>
                {step.description && <p className="plan-step__description">{step.description}</p>}
              </>
            )}
          </li>
        ))}
      </ol>
      {editing && (
        <button type="button" className="interaction__action interaction__action--secondary" onClick={addStep}>
          + Add step
        </button>
      )}
      <div className="interaction__actions">
        {!editing && (
          <button type="button" className="interaction__action interaction__action--secondary" onClick={() => setEditing(true)}>
            Edit Plan
          </button>
        )}
        {editing && (
          <button type="button" className="interaction__action interaction__action--primary" onClick={saveAndContinue}>
            Save &amp; Continue
          </button>
        )}
        {!editing && (
          <button type="button" className="interaction__action interaction__action--primary" onClick={() => resolve({ action: "approve" })}>
            Approve &amp; Continue
          </button>
        )}
        <button type="button" className="interaction__action interaction__action--danger" onClick={() => resolve({ action: "reject" })}>
          Reject
        </button>
      </div>
    </div>
  );
}

/**
 * §7's single generic renderer for every interrupt() call site in researchGraph.ts. Mounted
 * once per chat; `useInterrupt`'s default `renderInChat: true` publishes whichever variant is
 * active directly into the CopilotChat transcript, so this component itself renders nothing.
 */
export default function InteractionRenderer() {
  useInterrupt({
    render: ({ event, resolve }) => {
      const value = event?.value as AgentInteraction | undefined;
      const doResolve: Resolve = (payload) => {
        void resolve(payload);
      };

      if (!value) return <></>;
      if (value.type === "approval") return <ApprovalInteraction value={value} resolve={doResolve} />;
      if (value.type === "question") return <QuestionInteraction value={value} resolve={doResolve} />;
      return <PlanEditInteraction value={value} resolve={doResolve} />;
    },
  });

  return null;
}
