import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import type { AIMessageChunk } from "@langchain/core/messages";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { ensureMemoryIndexes } from "./memory/collections.js";
import { registerAuthRoutes, requireAuth, type AuthedRequest } from "./auth.js";
import { runAgent } from "./agent.js";
import { runResearchAgent } from "./agents/researchAgent.js";
import { runQnaAgent } from "./agents/qnaAgent.js";
import { routeToAgent } from "./router.js";
import { planGoal } from "./planner.js";
import { classifyApproval } from "./approval.js";
import { goalService } from "./memory/goalService.js";
import { DEFAULT_TENANT_ID } from "./constants.js";
import type { GoalRecord } from "./memory/types.js";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { buildCopilotAgents } from "./copilotRuntime.js";
import { ensureThreadOwnershipIndexes } from "./threadOwnership.js";

function formatPlanPrompt(goal: GoalRecord): string {
  const steps = goal.steps.map((s, i) => `${i + 1}. [${s.agent}] ${s.description}`).join("\n");
  return `Here's my plan for "${goal.title}":\n${steps}\n\nShall I go ahead? (yes/no)`;
}

const AGENT_RUNNERS = {
  clockwork: runAgent,
  research: runResearchAgent,
  qna: runQnaAgent,
} as const;

type AgentName = keyof typeof AGENT_RUNNERS;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "../../web/dist");

function extractText(content: AIMessageChunk["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is { type: "text"; text: string } => "type" in part && part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function main() {
  await connectDb();
  await ensureMemoryIndexes();
  await ensureThreadOwnershipIndexes();
  console.log(`Connected to MongoDB (${config.mongoUri}${config.mongoDbName})`);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(webDir));

  registerAuthRoutes(app);

  const copilotRuntime = new CopilotRuntime({ agents: buildCopilotAgents });
  app.use(createCopilotExpressHandler({ runtime: copilotRuntime, basePath: "/api/copilotkit" }));

  app.post("/api/chat", requireAuth, async (req: AuthedRequest, res) => {
    const { messages, agent } = req.body ?? {};
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    const userId = req.userId!;
    const latestUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      let agentName: AgentName | null = null;
      let goalId: string | null = null;
      let stepDescription: string | null = null;
      // Set instead of agentName when this turn is fully handled without running any specialist
      // agent - e.g. presenting a plan for approval, or acknowledging a rejection.
      let directResponseText: string | null = null;

      if (typeof agent === "string" && agent in AGENT_RUNNERS) {
        // Explicit client override always wins, and doesn't touch goal tracking.
        agentName = agent as AgentName;
      } else {
        const proposedGoal = await goalService.getProposedGoal(DEFAULT_TENANT_ID, userId);

        if (proposedGoal) {
          // A plan is awaiting the user's go-ahead - this turn only interprets their reply to it,
          // it never runs a specialist agent directly (human-in-the-loop gate).
          const decision = await classifyApproval(latestUserMessage);
          if (decision === "approve") {
            const approved = await goalService.approveGoal(proposedGoal.id);
            const firstStep = approved?.steps[approved.currentStepIndex];
            if (approved && firstStep) {
              agentName = firstStep.agent;
              goalId = approved.id;
              stepDescription = firstStep.description;
            }
          } else if (decision === "reject") {
            await goalService.abandonGoal(proposedGoal.id);
            directResponseText = "No problem, I've cancelled that plan. Let me know if you'd like a different approach.";
          } else {
            directResponseText = `I didn't catch a clear yes or no. ${formatPlanPrompt(proposedGoal)}`;
          }
        } else {
          const activeGoal = await goalService.getActiveGoal(DEFAULT_TENANT_ID, userId);
          const currentStep = activeGoal?.steps[activeGoal.currentStepIndex];

          if (activeGoal && currentStep) {
            // Resume an in-progress (already-approved) goal: the next pending step decides the
            // agent, not the raw message.
            agentName = currentStep.agent;
            goalId = activeGoal.id;
            stepDescription = currentStep.description;
          } else {
            const plan = await planGoal(latestUserMessage);
            if (plan) {
              // Propose, don't execute yet - wait for the user's approval on the next turn.
              const goal = await goalService.proposeGoal(DEFAULT_TENANT_ID, userId, plan.title, plan.steps);
              directResponseText = formatPlanPrompt(goal);
            } else {
              agentName = await routeToAgent(latestUserMessage);
            }
          }
        }
      }

      res.write(`data: ${JSON.stringify({ agent: agentName, step: stepDescription })}\n\n`);

      if (directResponseText) {
        res.write(`data: ${JSON.stringify({ delta: directResponseText })}\n\n`);
      } else if (agentName) {
        const runAgentFn = AGENT_RUNNERS[agentName];
        const agentMessages = stepDescription
          ? [...messages.slice(0, -1), { role: "user", content: `${latestUserMessage}\n\n(Current step to work on: ${stepDescription})` }]
          : messages;

        const stream = await runAgentFn(userId, agentMessages);
        for await (const [chunk] of stream) {
          if (chunk.getType() !== "ai") {
            continue;
          }

          const text = extractText(chunk.content);
          if (text) {
            res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
          }
        }

        if (goalId) {
          const updatedGoal = await goalService.advanceCurrentStep(goalId);
          if (updatedGoal) {
            const doneCount = updatedGoal.steps.filter((s) => s.status === "done").length;
            res.write(
              `data: ${JSON.stringify({
                goalProgress: {
                  title: updatedGoal.title,
                  status: updatedGoal.status,
                  doneSteps: doneCount,
                  totalSteps: updatedGoal.steps.length,
                  nextStep: updatedGoal.steps[updatedGoal.currentStepIndex]?.description ?? null,
                },
              })}\n\n`,
            );
          }
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (error) {
      console.error("Agent run failed:", error);
      res.write(`data: ${JSON.stringify({ error: "Something went wrong processing your message." })}\n\n`);
    } finally {
      res.end();
    }
  });

  app.listen(config.port, () => {
    console.log(`System1 chat agent listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error("Chat agent server failed to start:", error);
  process.exit(1);
});
