import { connectDb } from "../db.js";
import { ensureMemoryV2Indexes } from "../memory/collections.js";
import { memoryWorker } from "../memory/v2/memoryWorker.js";

/**
 * Standalone deployable process - the third leg of the three-process deployment (Express API,
 * LangGraph API, memory:worker) per PLAN.md. Independent of index.ts/graph:dev; connects to
 * Mongo itself and polls memory_events forever.
 *
 * Run with: node --env-file=.env dist/scripts/runMemoryWorker.js
 */
async function main(): Promise<void> {
  await connectDb();
  await ensureMemoryV2Indexes();
  console.log(`Memory worker started (ownerId=${memoryWorker.ownerId}).`);

  // Every ordinary container restart/redeploy sends one of these. Without a handler, the process
  // is killed mid-tick and whatever batch it holds is stranded in "processing" until its lease
  // expires (now reclaimed automatically - see repository.ts's eligibilityFilter - but a clean
  // shutdown avoids the stranding, and the retry, in the first place). requestStop() lets the
  // in-flight tick finish rather than tearing it down mid-batch.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Memory worker received ${signal} - finishing the in-flight batch, then exiting.`);
    memoryWorker.requestStop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await memoryWorker.runForever();
  console.log("Memory worker exited cleanly.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Memory worker crashed:", error);
  process.exit(1);
});
