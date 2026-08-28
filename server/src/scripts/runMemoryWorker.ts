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
  await memoryWorker.runForever();
}

main().catch((error) => {
  console.error("Memory worker crashed:", error);
  process.exit(1);
});
