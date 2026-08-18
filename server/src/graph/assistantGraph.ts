import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Annotation, StateGraph, MessagesAnnotation, START, END, interrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, trimMessages, type BaseMessage } from "@langchain/core/messages";
import { model } from "../llm.js";
import { buildTools } from "../agents/sharedTools.js";
import { buildWebSearchTool } from "../agents/webSearchTool.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { goalService } from "../memory/goalService.js";
import type { GoalRecord } from "../memory/types.js";
import { extractText } from "../agents/shared.js";
import { DEFAULT_TENANT_ID } from "../constants.js";
import { ASSISTANT_SYSTEM_PROMPT } from "../assistantPrompt.js";
import { ensureGraphReady } from "./simpleAgentGraph.js";
import { silentJsonCompletion } from "../silentModel.js";
import type { ResearchPlan } from "./planTypes.js";
import type { AgentInteraction } from "./interactionTypes.js";
import { appendNotLinkedButton } from "./notLinkedButton.js";
import { extractPassiveFacts, persistChatMemory, recordEpisodeForRun, taskFromLatestUserMessage, type ToolCallRecord } from "./executePersistence.js";

const MAX_TOOL_ITERATIONS = 6;

// LangGraph's thread checkpointing keeps every message for the life of a thread, and nothing
// upstream of runReactLoop ever shrinks it - without this, a long-running thread eventually
// exceeds the model's input context window (hits sooner on smaller-context OpenRouter models
// than on Gemini's 1M-token window, but unbounded growth gets there on any provider eventually).
// Budget is deliberately well under a typical provider window, not just under the largest one -
// this stays a no-op days into a normal conversation and only trims once history actually grows
// large, on any configured provider.
const MAX_HISTORY_TOKENS = 8000;

/**
 * Drops the oldest messages once prior history exceeds MAX_HISTORY_TOKENS, keeping the most
 * recent ones (the system prompt is added separately by the caller and is never part of this).
 * `startOn: "human"` guarantees the kept slice starts at a clean human-turn boundary rather than
 * mid-way through a tool-call/tool-result exchange - trimming to just after an AIMessage with
 * pending tool_calls but before its ToolMessage would send the model a dangling tool call with no
 * result, which most providers reject outright.
 */
async function trimHistory(messages: BaseMessage[]): Promise<BaseMessage[]> {
  if (messages.length === 0) return messages;
  return trimMessages(messages, {
    maxTokens: MAX_HISTORY_TOKENS,
    strategy: "last",
    tokenCounter: model,
    startOn: "human",
    includeSystem: false,
    allowPartial: false,
  });
}

function goalToPlan(goal: GoalRecord): ResearchPlan {
  return {
    version: 1,
    steps: goal.steps.map((s, index) => ({
      id: `${goal.id}:${index}`,
      title: s.title,
      description: s.description,
      status: s.status === "done" ? "completed" : "pending",
      order: index,
    })),
  };
}

const AssistantState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // Not cleared between turns the way `plan` is - checkGoalNode re-derives both from Mongo at the
  // start of every run anyway, so a stale value here is harmless, but nodes within a single run
  // (planner -> planReview -> execute) pass the goal id to each other through it.
  plan: Annotation<ResearchPlan | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  goalId: Annotation<string | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  // Routing-only: which durable-goal case checkGoalNode found this run, so routeAfterCheckGoal
  // doesn't have to infer it back out of `plan`/`goalId`.
  goalPhase: Annotation<"proposed" | "active" | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
});

type GraphState = typeof AssistantState.State;

function requireExternalUserId(config: RunnableConfig): string {
  const externalUserId = config.configurable?.externalUserId as string | undefined;
  if (!externalUserId) {
    throw new Error("assistantGraph requires config.configurable.externalUserId");
  }
  return externalUserId;
}

async function resolveContext(externalUserId: string) {
  await ensureGraphReady();
  const mcpTools = await buildTools(externalUserId);
  const tools = [...mcpTools, buildWebSearchTool(), ...buildMemoryTools(DEFAULT_TENANT_ID, externalUserId)];
  const preferenceContext = await composePreferenceContext(DEFAULT_TENANT_ID, externalUserId);
  const systemPrompt = preferenceContext ? `${ASSISTANT_SYSTEM_PROMPT}\n\n${preferenceContext}` : ASSISTANT_SYSTEM_PROMPT;
  return { tools, systemPrompt };
}

const PLAN_SCHEMA = z.object({
  isMultiStep: z.boolean(),
  title: z.string(),
  steps: z
    .array(z.object({ title: z.string(), description: z.string().optional() }))
    .max(10)
    .describe("Only meaningful when isMultiStep is true"),
});

const PLANNER_PROMPT = `You decide whether a user's request needs to be broken into a visible, ordered plan the \
user approves before you act, or whether it's simple enough to just do directly.

Set isMultiStep=true ONLY when the request genuinely requires more than one distinct step - either several \
different actions/investigations in sequence (e.g. "research the best approach for X, then start tracking time \
on implementing it"), or a single broad request that naturally breaks into multiple ordered sub-steps (e.g. an \
open-ended research question that needs several sub-investigations). A single question, a single action (start/ \
stop/delete one time entry, one lookup), or a short follow-up is NOT multi-step, even if it takes a couple tool \
calls to answer - set isMultiStep=false and leave steps empty; you'll go straight to handling it.

When isMultiStep is true, give the plan a short title and list 2-10 ordered, concrete, user-facing steps - never \
expose internal reasoning, only the observable steps. For open-ended research/investigation requests (anything \
you'd need web_search or several rounds of tool calls to answer thoroughly), plan deeper rather than shallower: \
break the topic into distinct sub-questions or angles (e.g. background/definitions, current state, comparison of \
options, tradeoffs, a synthesis/recommendation step) instead of one vague "research X" step, and give each step a \
one-sentence description of what specifically it should establish so the step is actionable on its own, not just \
a restated title. Keep steps this granular only when the request is genuinely broad - a request that's naturally \
a single or two-step lookup should still stay short.

Respond with ONLY a JSON object (no markdown, no code fences, no commentary) matching exactly this shape:
{"isMultiStep": boolean, "title": string, "steps": [{"title": string, "description": string}]}
"steps" must be [] when isMultiStep is false.`;

interface ReactLoopResult {
  messages: Array<AIMessage | ToolMessage>;
  toolCalls: ToolCallRecord[];
}

/** Runs the model-call/tool-execution loop; used both for a single-shot (non-plan) turn and for
 * executing an approved plan's steps in one combined pass. Also returns per-call detail
 * (arguments/result/timing) for tool_executions - the episode summary alone is too coarse to be
 * traceable independently. */
async function runReactLoop(state: GraphState, config: RunnableConfig, externalUserId: string, focusNote?: string): Promise<ReactLoopResult> {
  const { tools, systemPrompt } = await resolveContext(externalUserId);
  const toolsByName = new Map(tools.map((t) => [t.name, t as { invoke: (input: unknown, config?: unknown) => Promise<unknown> }]));
  const modelWithTools = model.bindTools(tools);

  const trimmedHistory = await trimHistory(state.messages);
  let messages: BaseMessage[] = [new SystemMessage(systemPrompt), ...trimmedHistory];
  if (focusNote) messages.push(new HumanMessage(focusNote));

  const newMessages: Array<AIMessage | ToolMessage> = [];
  const toolCalls: ToolCallRecord[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await modelWithTools.invoke(messages, config);
    newMessages.push(response);
    messages = [...messages, response];

    if (!response.tool_calls?.length) break;

    for (const call of response.tool_calls) {
      const tool = toolsByName.get(call.name);
      const startedAt = new Date().toISOString();
      const result: unknown = tool ? await tool.invoke(call.args, config) : `Unknown tool: ${call.name}`;
      const completedAt = new Date().toISOString();
      const resultText = typeof result === "string" ? result : JSON.stringify(result);
      toolCalls.push({
        toolName: call.name,
        arguments: call.args as Record<string, unknown> | undefined,
        result,
        status: resultText.startsWith("Unknown tool:") || resultText.startsWith("NOT_LINKED::") ? "error" : "success",
        startedAt,
        completedAt,
      });
      const toolMessage = new ToolMessage({
        content: resultText,
        tool_call_id: call.id ?? "",
        name: call.name,
      });
      newMessages.push(toolMessage);
      messages = [...messages, toolMessage];
    }
  }

  // If the loop exhausted MAX_TOOL_ITERATIONS while the model was still issuing tool calls (e.g.
  // retrying after repeated tool failures), the last pushed message is an AIMessage with only
  // tool_calls and no text - that renders as nothing in the UI. Give the user something visible
  // rather than a silent turn.
  const lastMessage = newMessages[newMessages.length - 1];
  if (!lastMessage || (lastMessage.getType() === "ai" && extractText(lastMessage.content).length === 0)) {
    newMessages.push(
      new AIMessage(
        "Sorry, I wasn't able to finish that after a few attempts. Please try again in a moment.",
      ),
    );
  }

  return { messages: newMessages, toolCalls };
}

/** Looks up whether this user already has a durable goal (proposed - awaiting approval, or
 * active - mid-execution) before ever asking the planner to decide fresh. This is what makes
 * goal tracking survive across turns/threads/restarts: it's not read from this run's LangGraph
 * state, it's read from Mongo by userId every single time a run starts. */
async function checkGoalNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const externalUserId = requireExternalUserId(config);
  await ensureGraphReady();

  const proposed = await goalService.getProposedGoal(DEFAULT_TENANT_ID, externalUserId);
  if (proposed) return { plan: goalToPlan(proposed), goalId: proposed.id, goalPhase: "proposed" };

  const active = await goalService.getActiveGoal(DEFAULT_TENANT_ID, externalUserId);
  if (active) return { plan: goalToPlan(active), goalId: active.id, goalPhase: "active" };

  return { plan: null, goalId: null, goalPhase: null };
}

/** Decides isMultiStep for the newest user message; on error, falls back to handling it directly
 * rather than blocking the turn on a broken planning call. Uses a raw HTTP call (silentModel.ts)
 * rather than a LangChain ChatModel - a Runnable invocation was observed leaking its raw JSON
 * into the AG-UI chat stream as a garbled message even when tagged "langsmith:nostream", since
 * LangGraph's message-streaming hooks into LangChain's callback system; a plain fetch() has no
 * Runnable/callback involvement for that machinery to capture. */
async function plannerNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const latestUserMessage = [...state.messages].reverse().find((m) => m.getType() === "human");
  const task = latestUserMessage ? String(latestUserMessage.content) : "";
  const externalUserId = requireExternalUserId(config);

  try {
    const result = await silentJsonCompletion(PLANNER_PROMPT, task, PLAN_SCHEMA);

    if (!result.isMultiStep || result.steps.length < 2) return { plan: null, goalId: null };

    const threadId = (config.configurable?.thread_id as string | undefined) ?? null;
    const goal = await goalService.proposeGoal(DEFAULT_TENANT_ID, externalUserId, threadId, result.title, result.steps);
    return { plan: goalToPlan(goal), goalId: goal.id };
  } catch (error) {
    console.error("Assistant plan generation failed, handling the request directly:", error);
    return { plan: null, goalId: null };
  }
}

/** Pause for the user to approve/edit/reject the plan before anything runs. Reuses the same
 * plan_edit interaction (and its richer edit/reorder/skip UI) researchGraph.ts established -
 * resume shape: `{ action: "approve" } | { action: "update", plan: ResearchPlan } | { action: "reject" }`. */
async function planReviewNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.plan || !state.goalId) return {};

  const interaction: AgentInteraction = { type: "plan_edit", id: randomUUID(), plan: state.plan };
  const resume = interrupt(interaction) as { action: "approve" | "update" | "reject"; plan?: ResearchPlan };

  if (resume.action === "reject") {
    await goalService.abandonGoal(state.goalId);
    return {
      plan: null,
      goalId: null,
      messages: [new AIMessage("Okay, I've cancelled that plan. Let me know if you'd like a different approach.")],
    };
  }

  if (resume.action === "update" && resume.plan) {
    const goal = await goalService.updateSteps(
      state.goalId,
      resume.plan.steps.map((s) => ({ title: s.title, description: s.description })),
    );
    if (!goal) return {};
    await goalService.approveGoal(goal.id);
    return { plan: goalToPlan(goal) };
  }

  await goalService.approveGoal(state.goalId);
  return {};
}

/** Executes a single-shot request, or - when there's a durable goal - only its current step
 * (one step per user turn, per goal design). A goal's progress lives in Mongo, not this run's
 * state, so after finishing a non-final step we deliberately leave it there for checkGoalNode to
 * pick back up on the next turn, whatever the user's next message says. Only clears `plan`/
 * `goalId` for the non-goal path and once the goal's last step completes. */
async function executeNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const externalUserId = requireExternalUserId(config);
  const threadId = (config.configurable?.thread_id as string | undefined) ?? null;

  if (!state.goalId) {
    const { messages: newMessages, toolCalls } = await runReactLoop(state, config, externalUserId);
    appendNotLinkedButton(newMessages);
    await persistChatMemory(state, config, externalUserId, newMessages);
    await recordEpisodeForRun(externalUserId, threadId, taskFromLatestUserMessage(state), newMessages, toolCalls, null, null);
    await extractPassiveFacts(externalUserId, taskFromLatestUserMessage(state));
    return { messages: newMessages, plan: null, goalId: null };
  }

  const goal = await goalService.getGoalById(state.goalId);
  const currentStep = goal?.steps[goal.currentStepIndex];
  if (!goal || !currentStep) {
    // Nothing left to run (e.g. goal already completed by a concurrent turn) - fall back to a
    // plain single-shot reply rather than getting stuck.
    const { messages: newMessages, toolCalls } = await runReactLoop(state, config, externalUserId);
    appendNotLinkedButton(newMessages);
    await persistChatMemory(state, config, externalUserId, newMessages);
    await recordEpisodeForRun(externalUserId, threadId, taskFromLatestUserMessage(state), newMessages, toolCalls, null, null);
    await extractPassiveFacts(externalUserId, taskFromLatestUserMessage(state));
    return { messages: newMessages, plan: null, goalId: null };
  }

  const stepNumber = goal.currentStepIndex + 1;
  const stepTask = `${currentStep.title}${currentStep.description ? ` - ${currentStep.description}` : ""}`;
  const focusNote = `(Working on step ${stepNumber}/${goal.steps.length} of the goal "${goal.title}": ${stepTask})`;

  const { messages: newMessages, toolCalls } = await runReactLoop(state, config, externalUserId, focusNote);
  appendNotLinkedButton(newMessages);
  await persistChatMemory(state, config, externalUserId, newMessages);
  await recordEpisodeForRun(externalUserId, threadId, stepTask, newMessages, toolCalls, goal.id, goal.currentStepIndex);
  // Extract from the user's actual latest message, not `stepTask` (the goal step's own synthetic
  // title/description) - the user's raw wording is what might carry an implicit preference/fact.
  await extractPassiveFacts(externalUserId, taskFromLatestUserMessage(state));

  const updatedGoal = await goalService.completeCurrentStep(goal.id);
  if (updatedGoal && updatedGoal.status === "done") {
    return { messages: newMessages, plan: null, goalId: null };
  }

  return { messages: newMessages, plan: updatedGoal ? goalToPlan(updatedGoal) : state.plan, goalId: goal.id };
}

function routeAfterCheckGoal(state: GraphState): "planReview" | "execute" | "planner" {
  if (state.goalPhase === "proposed") return "planReview";
  if (state.goalPhase === "active") return "execute";
  return "planner";
}

function routeAfterPlanner(state: GraphState): "planReview" | "execute" {
  return state.plan ? "planReview" : "execute";
}

function routeAfterPlanReview(state: GraphState): "execute" | typeof END {
  return state.plan ? "execute" : END;
}

/**
 * checkGoal (look up an existing Mongo goal for this user) -->
 *   [proposed goal found]      planReview (re-present it for approval)
 *   [active goal found]        execute (work its current step)
 *   [no goal found]            planner (decide isMultiStep fresh)
 * planner --> [not multi-step] execute -> END
 *         --> [multi-step, now persisted to Mongo] planReview (interrupt: edit/approve/reject) ->
 *             [approved/updated] execute -> END
 *             [rejected]         END
 * execute runs one step of an active goal (or the whole thing, for a non-goal single-shot
 * request) and always ends the turn - a goal's remaining steps are picked up by checkGoal on
 * whichever future turn comes next, not by looping within this run.
 */
export const assistantGraph = new StateGraph(AssistantState)
  .addNode("checkGoal", checkGoalNode)
  .addNode("planner", plannerNode)
  .addNode("planReview", planReviewNode)
  .addNode("execute", executeNode)
  .addEdge(START, "checkGoal")
  .addConditionalEdges("checkGoal", routeAfterCheckGoal, ["planReview", "execute", "planner"])
  .addConditionalEdges("planner", routeAfterPlanner, ["planReview", "execute"])
  .addConditionalEdges("planReview", routeAfterPlanReview, ["execute", END])
  .addEdge("execute", END)
  .compile();
