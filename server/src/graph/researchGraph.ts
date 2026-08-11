import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Annotation, StateGraph, MessagesAnnotation, START, END, interrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { model, createModel } from "../llm.js";
import { buildTools } from "../agents/sharedTools.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { DEFAULT_TENANT_ID } from "../constants.js";
import { RESEARCH_SYSTEM_PROMPT } from "../agents/researchAgent.js";
import { extractText } from "../agents/shared.js";
import { connectDb } from "../db.js";
import { ensureMemoryIndexes } from "../memory/collections.js";
import type { ResearchPlan, ResearchPlanStep } from "./planTypes.js";
import type { AgentInteraction } from "./interactionTypes.js";

const MAX_TOOL_ITERATIONS = 6;

const ResearchState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // Null until the planner node runs once per thread; LangGraph's checkpointer persists it
  // across turns, so later runs on the same thread skip straight past planning/step-execution.
  plan: Annotation<ResearchPlan | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  currentStepId: Annotation<string | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  finalAnswer: Annotation<string | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
});

type GraphState = typeof ResearchState.State;

// This graph module can be loaded standalone by `langgraphjs dev`/platform (no shared process
// with index.ts's Express startup), so it must establish its own DB connection rather than
// assuming one already exists. connectDb() is idempotent, so this is a no-op when this module
// happens to run inside the main server process instead.
let readyPromise: Promise<void> | undefined;
function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = connectDb().then(() => ensureMemoryIndexes());
  }
  return readyPromise;
}

async function resolveContext(externalUserId: string) {
  await ensureReady();
  const mcpTools = await buildTools(externalUserId);
  const tools = [...mcpTools, ...buildMemoryTools(DEFAULT_TENANT_ID, externalUserId)];
  const preferenceContext = await composePreferenceContext(DEFAULT_TENANT_ID, externalUserId);
  const systemPrompt = preferenceContext ? `${RESEARCH_SYSTEM_PROMPT}\n\n${preferenceContext}` : RESEARCH_SYSTEM_PROMPT;
  return { tools, systemPrompt };
}

/** The model-call + tool-execution loop shared by runStep (one plan step) and followUp (a
 * post-research chat message on an already-completed thread) - see researchGraph's doc comment
 * on the compiled graph below for why these are the only two places it's needed. */
async function runReactLoop(
  state: GraphState,
  config: RunnableConfig,
  externalUserId: string,
  focusNote?: string,
): Promise<Array<AIMessage | ToolMessage>> {
  const { tools, systemPrompt } = await resolveContext(externalUserId);
  const toolsByName = new Map(tools.map((t) => [t.name, t as { invoke: (input: unknown, config?: unknown) => Promise<unknown> }]));
  const modelWithTools = model.bindTools(tools);

  let messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...state.messages];
  if (focusNote) messages.push(new HumanMessage(focusNote));

  const newMessages: Array<AIMessage | ToolMessage> = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await modelWithTools.invoke(messages, config);
    newMessages.push(response);
    messages = [...messages, response];

    if (!response.tool_calls?.length) break;

    for (const call of response.tool_calls) {
      const tool = toolsByName.get(call.name);
      const result: unknown = tool ? await tool.invoke(call.args, config) : `Unknown tool: ${call.name}`;
      const toolMessage = new ToolMessage({
        content: typeof result === "string" ? result : JSON.stringify(result),
        tool_call_id: call.id ?? "",
        name: call.name,
      });
      newMessages.push(toolMessage);
      messages = [...messages, toolMessage];
    }
  }

  return newMessages;
}

function requireExternalUserId(config: RunnableConfig): string {
  const externalUserId = config.configurable?.externalUserId as string | undefined;
  if (!externalUserId) {
    throw new Error("researchGraph requires config.configurable.externalUserId");
  }
  return externalUserId;
}

const PLAN_SCHEMA = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().describe("Short, user-facing title for this research step"),
        description: z.string().optional().describe("One sentence on what this step involves"),
      }),
    )
    .min(2)
    .max(8),
});

const PLANNER_PROMPT = `You are planning a research task before any investigation happens. Break the user's \
request into 2-8 ordered, concrete steps a research agent will carry out (e.g. "Identify major approaches", \
"Survey recent developments", "Compare tradeoffs", "Draft final report"). Titles are short and user-facing - \
never expose internal reasoning or chain-of-thought, only the observable steps.`;

/** Generates the plan the UI displays, once per thread. */
async function plannerNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const latestUserMessage = [...state.messages].reverse().find((m) => m.getType() === "human");
  const task = latestUserMessage ? extractText(latestUserMessage.content) : "";

  try {
    const structuredModel = createModel(400).withStructuredOutput(PLAN_SCHEMA);
    const result = (await structuredModel.invoke(
      [
        { role: "system", content: PLANNER_PROMPT },
        { role: "user", content: task },
      ],
      config,
    )) as z.infer<typeof PLAN_SCHEMA>;

    const plan: ResearchPlan = {
      version: 1,
      steps: result.steps.map((step, index) => ({
        id: randomUUID(),
        title: step.title,
        description: step.description,
        status: "pending",
        order: index,
      })),
    };
    return { plan };
  } catch (error) {
    console.error("Research plan generation failed, continuing without a plan:", error);
    return { plan: { version: 1, steps: [] } };
  }
}

/**
 * Phase 4/5's first checkpoint: pause and show the freshly generated plan for edit/approve/
 * reject before any research happens (spec §5/§6). Resume value shape (sent by the client via
 * a Command({resume})): `{ action: "approve" } | { action: "update", plan: ResearchPlan } | { action: "reject" }`.
 */
async function planReviewNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.plan || state.plan.steps.length === 0) {
    // Planning itself failed (see plannerNode's catch) - nothing to review, skip straight to a
    // plain conversational pass instead of showing an empty plan for approval.
    return {};
  }

  const interaction: AgentInteraction = { type: "plan_edit", id: randomUUID(), plan: state.plan };
  const resume = interrupt(interaction) as { action: "approve" | "update" | "reject"; plan?: ResearchPlan };

  if (resume.action === "reject") {
    return {
      finalAnswer: "Okay, I've cancelled that research plan. Let me know if you'd like a different approach.",
      messages: [new AIMessage("Okay, I've cancelled that research plan. Let me know if you'd like a different approach.")],
    };
  }

  if (resume.action === "update" && resume.plan) {
    return { plan: { ...resume.plan, version: state.plan.version + 1 } };
  }

  return {};
}

const CLARIFY_SCHEMA = z.object({
  needsClarification: z.boolean(),
  question: z.string().optional(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .max(4)
    .optional(),
});

const CLARIFY_PROMPT = `You are about to work on one step of a research plan. Decide whether you need the \
user's preference on something material before proceeding (e.g. which sources to prioritize, which market/\
timeframe/angle to focus on) - most steps do NOT need this, only ask when the step is genuinely ambiguous \
without it. If you do need to ask, phrase a short question and propose 2-4 concrete recommended options based \
on the step and conversation so far - never leave the options generic ("option 1/2/3").`;

/**
 * Phase 6: the agent-generated clarifying question (spec §8/§9). This is a dedicated node
 * (rather than a tool the ReAct loop can call mid-step) specifically so its only side effect is
 * the interrupt itself - LangGraph replays a node from the top on resume, and this node makes no
 * tool calls before its interrupt(), so that replay is safe. Giving the loop in runStepNode an
 * "ask_user" tool instead would risk re-running any tool calls made earlier in that same
 * iteration when the node resumes, including non-idempotent ones (e.g. starting a time entry
 * twice) - not a risk clockwork's tools take today since this node never calls them, but worth
 * keeping in mind if this pattern is reused elsewhere.
 */
async function clarifyStepNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const step = state.plan?.steps.find((s) => s.id === state.currentStepId);
  if (!step) return {};

  try {
    const structuredModel = createModel(300).withStructuredOutput(CLARIFY_SCHEMA);
    const result = (await structuredModel.invoke(
      [
        { role: "system", content: CLARIFY_PROMPT },
        { role: "user", content: `Step: ${step.title}${step.description ? ` - ${step.description}` : ""}` },
      ],
      config,
    )) as z.infer<typeof CLARIFY_SCHEMA>;

    if (!result.needsClarification || !result.question || !result.options?.length) return {};

    const interaction: AgentInteraction = {
      type: "question",
      id: randomUUID(),
      question: result.question,
      options: result.options,
      allowCustomInput: true,
    };
    const resume = interrupt(interaction) as { optionId?: string; customText?: string };

    const chosen = resume.customText ?? result.options.find((o) => o.id === resume.optionId)?.label ?? resume.optionId ?? "";
    if (!chosen) return {};

    return { messages: [new HumanMessage(`(For "${step.title}": ${chosen})`)] };
  } catch (error) {
    console.error("Clarification check failed, continuing without asking:", error);
    return {};
  }
}

/** Picks the next pending step and marks it "running" - a separate, fast node (no LLM call) so
 * the client sees the status flip to "running" before the slower runStepNode actually starts
 * working, matching the spec's "⟳ Analyze findings" progress example. */
function startStepNode(state: GraphState): Partial<GraphState> {
  const nextStep = state.plan?.steps.find((s) => s.status === "pending");
  if (!nextStep || !state.plan) return { currentStepId: null };

  const steps = state.plan.steps.map((s) => (s.id === nextStep.id ? { ...s, status: "running" as const } : s));
  return { plan: { ...state.plan, steps }, currentStepId: nextStep.id };
}

async function runStepNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const externalUserId = requireExternalUserId(config);
  const step = state.plan?.steps.find((s) => s.id === state.currentStepId);
  const focusNote = step ? `(Current research step: "${step.title}"${step.description ? ` - ${step.description}` : ""})` : undefined;

  const newMessages = await runReactLoop(state, config, externalUserId, focusNote);

  if (!state.plan || !step) return { messages: newMessages };

  const steps = state.plan.steps.map((s) => (s.id === step.id ? { ...s, status: "completed" as ResearchPlanStep["status"] } : s));
  return { messages: newMessages, plan: { ...state.plan, steps }, currentStepId: null };
}

/**
 * Phase 5's second checkpoint: pause for approval before generating the final report (spec §6's
 * worked example - "I found 25 sources... ready to begin synthesis... Approve/Reject"). Resume
 * value: `{ decision: "approve" | "reject" }`.
 */
function synthesisApprovalNode(state: GraphState): Partial<GraphState> {
  const completedCount = state.plan?.steps.filter((s) => s.status === "completed").length ?? 0;
  const interaction: AgentInteraction = {
    type: "approval",
    id: randomUUID(),
    title: "Ready to synthesize",
    message: `I've finished ${completedCount} research step${completedCount === 1 ? "" : "s"}. Generate the final report from these findings?`,
    actions: [
      { id: "approve", label: "Approve & Continue", style: "primary" },
      { id: "reject", label: "Reject", style: "danger" },
    ],
  };
  const resume = interrupt(interaction) as { decision: "approve" | "reject" };

  if (resume.decision === "reject") {
    return {
      finalAnswer: "Understood - I've stopped before generating the final report. Let me know how you'd like to proceed.",
      messages: [new AIMessage("Understood - I've stopped before generating the final report. Let me know how you'd like to proceed.")],
    };
  }

  return {};
}

const SYNTHESIZE_PROMPT = `Synthesize the research so far into a clear, well-organized final answer citing what \
was found across the steps. Be explicit about any uncertainty or missing sources rather than fabricating.`;

async function synthesizeNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const externalUserId = requireExternalUserId(config);
  const { systemPrompt } = await resolveContext(externalUserId);
  // The step loop's last message is always an AI turn; some providers (Gemini) reject a request
  // whose final message isn't from the user, so the synthesis instruction has to be a trailing
  // HumanMessage, not just extra system-prompt text.
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...state.messages, new HumanMessage(SYNTHESIZE_PROMPT)];

  const response = await model.invoke(messages, config);
  return { messages: [response], finalAnswer: extractText(response.content) };
}

/** A normal conversational turn on a thread whose research already finished - re-uses the same
 * tool loop as each plan step, just with no step framing. */
async function followUpNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const externalUserId = requireExternalUserId(config);
  const newMessages = await runReactLoop(state, config, externalUserId);
  return { messages: newMessages };
}

function routeFromStart(state: GraphState): "planner" | "followUp" | "startStep" {
  if (state.finalAnswer !== null) return "followUp";
  if (state.plan === null) return "planner";
  // Mid-flow fresh runs shouldn't normally happen (the UI resumes a pending interrupt instead
  // of sending a new message), but if one arrives this re-enters the step loop harmlessly.
  return "startStep";
}

function routeAfterPlanReview(state: GraphState): "startStep" | typeof END {
  return state.finalAnswer !== null ? END : "startStep";
}

function routeAfterStartStep(state: GraphState): "clarifyStep" | "synthesisApproval" {
  return state.currentStepId ? "clarifyStep" : "synthesisApproval";
}

function routeAfterRunStep(state: GraphState): "startStep" {
  return "startStep";
}

function routeAfterSynthesisApproval(state: GraphState): "synthesize" | typeof END {
  return state.finalAnswer !== null ? END : "synthesize";
}

/**
 * Phases 1-7's cumulative shape: planner -> planReview (interrupt: edit/approve/reject the
 * plan) -> [startStep -> clarifyStep (interrupt: optional clarifying question) -> runStep] loop
 * over pending steps, marking each "running" then "completed" for live progress -> synthesis
 * Approval (interrupt: approve/reject the final report) -> synthesize. A thread whose research
 * already produced a finalAnswer instead routes new messages straight to followUp, a plain
 * tool-using chat turn with no plan/step machinery.
 */
export const researchGraph = new StateGraph(ResearchState)
  .addNode("planner", plannerNode)
  .addNode("planReview", planReviewNode)
  .addNode("startStep", startStepNode)
  .addNode("clarifyStep", clarifyStepNode)
  .addNode("runStep", runStepNode)
  .addNode("synthesisApproval", synthesisApprovalNode)
  .addNode("synthesize", synthesizeNode)
  .addNode("followUp", followUpNode)
  .addConditionalEdges(START, routeFromStart, ["planner", "followUp", "startStep"])
  .addEdge("planner", "planReview")
  .addConditionalEdges("planReview", routeAfterPlanReview, ["startStep", END])
  .addConditionalEdges("startStep", routeAfterStartStep, ["clarifyStep", "synthesisApproval"])
  .addEdge("clarifyStep", "runStep")
  .addConditionalEdges("runStep", routeAfterRunStep, ["startStep"])
  .addConditionalEdges("synthesisApproval", routeAfterSynthesisApproval, ["synthesize", END])
  .addEdge("synthesize", END)
  .addEdge("followUp", END)
  .compile();
