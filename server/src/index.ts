import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { ensureGoalIndexes, ensureMemoryV2Indexes, ensureThreadIndexes } from "./memory/collections.js";
import { registerAuthRoutes } from "./auth.js";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { buildCopilotAgents } from "./copilotRuntime.js";
import { registerThreadResyncRoute } from "./threadResync.js";
import { registerThreadsRoute } from "./threads.js";
import { registerSystem1StatusRoute } from "./system1Status.js";
import { registerMemorySettingsRoutes } from "./memory/v2/memorySettingsRoutes.js";
import { registerMemoriesRoutes } from "./memory/v2/memoriesRoutes.js";
import { registerWorkspaceRoutes } from "./memory/v2/workspaceRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "../../web/dist");

async function main() {
  await connectDb();
  await ensureGoalIndexes();
  await ensureThreadIndexes();
  await ensureMemoryV2Indexes();
  console.log(`Connected to MongoDB (${config.mongoUri}${config.mongoDbName})`);

  const app = express();
  // Default is 100kb - CopilotKit's agent-run requests post the full growing message history
  // each turn (tool call args/results accumulate across a thread), which exceeds that on any
  // conversation of nontrivial length.
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use(express.static(webDir));

  registerAuthRoutes(app);
  registerThreadResyncRoute(app);
  registerThreadsRoute(app);
  registerSystem1StatusRoute(app);
  registerMemorySettingsRoutes(app);
  registerMemoriesRoutes(app);
  registerWorkspaceRoutes(app);

  const copilotRuntime = new CopilotRuntime({ agents: buildCopilotAgents });
  app.use(
    createCopilotExpressHandler({
      runtime: copilotRuntime,
      basePath: "/api/copilotkit",
      // The default is { origin: "*" } with no Access-Control-Allow-Credentials header, which
      // browsers reject outright for the frontend's credentials: "include" fetches (the CopilotKit
      // client swallows that rejection silently and falls back to a broken single-route POST,
      // surfacing as a confusing 404/"agent_connect_failed" instead of a CORS error). `origin: true`
      // reflects the actual request Origin instead of a wildcard, which is required once credentials
      // are involved.
      cors: { origin: true, credentials: true },
    }),
  );

  app.listen(config.port, () => {
    console.log(`System1 chat agent listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error("Chat agent server failed to start:", error);
  process.exit(1);
});
