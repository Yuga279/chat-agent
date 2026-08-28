import { connectDb } from "../db.js";
import { ensureMemoryIndexes, ensureMemoryV2Indexes, ensureThreadIndexes } from "../memory/collections.js";

let readyPromise: Promise<void> | undefined;
/** Standalone-host bootstrap (see researchGraph.ts's ensureReady doc) - shared here so clockwork
 * and qna graphs don't each duplicate it. */
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
