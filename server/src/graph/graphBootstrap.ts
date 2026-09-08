import { connectDb } from "../db.js";
import { ensureMemoryIndexes, ensureMemoryV2Indexes, ensureThreadIndexes } from "../memory/collections.js";

let readyPromise: Promise<void> | undefined;
/** Connects to Mongo and ensures indexes exist, memoized so it only runs once per process.
 * assistantGraph.ts's checkGoalNode calls this itself as the graph's first node, since when
 * hosted standalone by `langgraphjs dev` nothing else has connected to Mongo yet at that point. */
export function ensureGraphReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = connectDb().then(async () => {
      await ensureMemoryIndexes();
      await ensureThreadIndexes();
      await ensureMemoryV2Indexes();
    });
  }
  return readyPromise;
}
