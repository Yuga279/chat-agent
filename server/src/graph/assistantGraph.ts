import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Annotation, StateGraph, MessagesAnnotation, START, END, interrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { model } from "../llm.js";
import { buildTools } from "../agents/sharedTools.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { memoryService } from "../memory/memoryService.js";
import { DEFAULT_TENANT_ID } from "../constants.js";
import { ASSISTANT_SYSTEM_PROMPT } from "../assistantPrompt.js";
import { ensureGraphReady } from "./simpleAgentGraph.js";
import { silentJsonCompletion } from "../silentModel.js";
import type { ResearchPlan } from "./planTypes.js";
import type { AgentInteraction } from "./interactionTypes.js";

const MAX_TOOL_ITERATIONS = 6;

const AssistantState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // Null at the start of every fresh run (executeNode always clears it before returning), so a
  // brand new user message always re-evaluates isMultiStep fresh rather than being stuck on a
  // decision from an earlier, unrelated task in the same conversation.
  plan: Annotation<ResearchPlan | null>({
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
  const tools = [...mcpTools, ...buildMemoryTools(DEFAULT_TENANT_ID, externalUserId)];
  const preferenceContext = await composePreferenceContext(DEFAULT_TENANT_ID, externalUserId);
  const systemPrompt = preferenceContext ? `${ASSISTANT_SYSTEM_PROMPT}\n\n${preferenceContext}` : ASSISTANT_SYSTEM_PROMPT;
  return { tools, systemPrompt };
}

const PLAN_SCHEMA = z.object({
  isMultiStep: z.boolean(),
  title: z.string(),
  steps: z
    .array(z.object({ title: z.string(), description: z.string().optional() }))
    .max(6)
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

When isMultiStep is true, give the plan a short title and list 2-6 ordered, concrete, user-facing steps - never \
expose internal reasoning, only the observable steps.

Respond with ONLY a JSON object (no markdown, no code fences, no commentary) matching exactly this shape:
{"isMultiStep": boolean, "title": string, "steps": [{"title": string, "description": string}]}
"steps" must be [] when isMultiStep is false.`;

/** Runs the model-call/tool-execution loop; used both for a single-shot (non-plan) turn and for
 * executing an approved plan's steps in one combined pass. */
async function runReactLoop(state: GraphState, config: RunnableConfig, externalUserId: string, focusNote?: string): Promise<Array<AIMessage | ToolMessage>> {
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

/** Decides isMultiStep for the newest user message; on error, falls back to handling it directly
 * rather than blocking the turn on a broken planning call. Uses a raw HTTP call (silentModel.ts)
 * rather than a LangChain ChatModel - a Runnable invocation was observed leaking its raw JSON
 * into the AG-UI chat stream as a garbled message even when tagged "langsmith:nostream", since
 * LangGraph's message-streaming hooks into LangChain's callback system; a plain fetch() has no
 * Runnable/callback involvement for that machinery to capture. */
async function plannerNode(state: GraphState): Promise<Partial<GraphState>> {
  const latestUserMessage = [...state.messages].reverse().find((m) => m.getType() === "human");
  const task = latestUserMessage ? String(latestUserMessage.content) : "";

  try {
    const result = await silentJsonCompletion(PLANNER_PROMPT, task, PLAN_SCHEMA);

    if (!result.isMultiStep || result.steps.length < 2) return { plan: null };

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
    console.error("Assistant plan generation failed, handling the request directly:", error);
    return { plan: null };
  }
}

/** Pause for the user to approve/edit/reject the plan before anything runs. Reuses the same
 * plan_edit interaction (and its richer edit/reorder/skip UI) researchGraph.ts established -
 * resume shape: `{ action: "approve" } | { action: "update", plan: ResearchPlan } | { action: "reject" }`. */
async function planReviewNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.plan) return {};

  const interaction: AgentInteraction = { type: "plan_edit", id: randomUUID(), plan: state.plan };
  const resume = interrupt(interaction) as { action: "approve" | "update" | "reject"; plan?: ResearchPlan };

  if (resume.action === "reject") {
    return {
      plan: null,
      messages: [new AIMessage("Okay, I've cancelled that plan. Let me know if you'd like a different approach.")],
    };
  }

  if (resume.action === "update" && resume.plan) {
    return { plan: { ...resume.plan, version: state.plan.version + 1 } };
  }

  return {};
}

/** Executes a single-shot request, or an approved plan's steps in one combined pass - always
 * clears `plan` afterward so the next fresh user message re-evaluates isMultiStep from scratch. */
async function executeNode(state: GraphState, config: RunnableConfig): Promise<Partial<GraphState>> {
  const externalUserId = requireExternalUserId(config);
  const focusNote = state.plan
    ? `(Approved plan - work through these steps in order: ${state.plan.steps
        .filter((s) => s.status !== "skipped")
        .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` - ${s.description}` : ""}`)
        .join(" ")})`
    : undefined;

  const newMessages = await runReactLoop(state, config, externalUserId, focusNote);
  await persistChatMemory(state, config, externalUserId, newMessages);
  return { messages: newMessages, plan: null };
}

/** Mirrors this turn's user message and final assistant reply into MongoDB (`conversation_messages`),
 * in addition to LangGraph's own thread checkpointing - see MemoryService.addMessage. Best-effort:
 * a failure here must never break the actual chat turn. */
async function persistChatMemory(
  state: GraphState,
  config: RunnableConfig,
  externalUserId: string,
  newMessages: Array<AIMessage | ToolMessage>,
): Promise<void> {
  const sessionId = config.configurable?.thread_id as string | undefined;
  if (!sessionId) return;

  try {
    const latestUserMessage = [...state.messages].reverse().find((m) => m.getType() === "human");
    if (latestUserMessage) {
      await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, sessionId, "user", String(latestUserMessage.content));
    }

    const finalReply = [...newMessages].reverse().find((m) => m instanceof AIMessage && typeof m.content === "string" && m.content.length > 0);
    if (finalReply) {
      await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, sessionId, "assistant", String(finalReply.content));
    }
  } catch (error) {
    console.error("persistChatMemory failed (chat turn continues normally):", error);
  }
}

function routeAfterPlanner(state: GraphState): "planReview" | "execute" {
  return state.plan ? "planReview" : "execute";
}

function routeAfterPlanReview(state: GraphState): "execute" | typeof END {
  return state.plan ? "execute" : END;
}

/**
 * planner (decide isMultiStep) -> [not multi-step] execute -> END
 *                              -> [multi-step] planReview (interrupt: edit/approve/reject) ->
 *                                 [approved/updated] execute -> END
 *                                 [rejected] END
 * Every run starts fresh at planner - `plan` is always null entering a new run (executeNode
 * clears it, planReviewNode clears it on reject), so there's no "resume a stale plan" branch to
 * route around like researchGraph.ts needs; a genuine mid-flow resume re-enters directly at the
 * interrupted node (LangGraph mechanics), never back at START.
 */
export const assistantGraph = new StateGraph(AssistantState)
  .addNode("planner", plannerNode)
  .addNode("planReview", planReviewNode)
  .addNode("execute", executeNode)
  .addEdge(START, "planner")
  .addConditionalEdges("planner", routeAfterPlanner, ["planReview", "execute"])
  .addConditionalEdges("planReview", routeAfterPlanReview, ["execute", END])
  .addEdge("execute", END)
  .compile();
