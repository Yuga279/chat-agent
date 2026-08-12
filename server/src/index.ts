import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { ensureMemoryIndexes } from "./memory/collections.js";
import { registerAuthRoutes } from "./auth.js";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { buildCopilotAgents } from "./copilotRuntime.js";
import { ensureThreadOwnershipIndexes } from "./threadOwnership.js";
import { registerThreadResyncRoute } from "./threadResync.js";
import { registerThreadsRoute } from "./threads.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "../../web/dist");

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
  registerThreadResyncRoute(app);
  registerThreadsRoute(app);

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
