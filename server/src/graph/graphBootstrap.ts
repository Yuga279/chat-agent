import { connectDb } from "../db.js";
import { ensureMemoryIndexes } from "../memory/collections.js";

let readyPromise: Promise<void> | undefined;
/** Standalone-host bootstrap (see researchGraph.ts's ensureReady doc) - shared here so clockwork
 * and qna graphs don't each duplicate it. */
export function ensureGraphReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = connectDb().then(() => ensureMemoryIndexes());
  }
  return readyPromise;
}
