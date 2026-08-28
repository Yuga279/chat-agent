import { connectDb, getDb } from "../db.js";
import { embedText } from "../memory/embeddings.js";

/**
 * Pre-rollout gate for MEMORY_V2_ENABLED: confirms the two Atlas Search indexes exist and are
 * queryable, and that a live Gemini embedding call actually succeeds - both must pass before v2
 * retrieval can work at all.
 *
 * Run with: node --env-file=.env dist/scripts/verifyMemoryV2.js
 */
async function main(): Promise<void> {
  await connectDb();
  const memoryItems = getDb().collection("memory_items");

  let ok = true;

  const indexes = (await memoryItems.listSearchIndexes().toArray()) as Array<{ name: string; status?: string }>;
  for (const name of ["memory-items-vector", "memory-items-text"]) {
    const found = indexes.find((i) => i.name === name);
    if (!found) {
      console.error(`Missing Atlas Search index "${name}" - run npm run memory:provision-indexes first.`);
      ok = false;
    } else if (found.status !== "READY") {
      console.error(`Atlas Search index "${name}" exists but status is "${found.status}", not READY yet.`);
      ok = false;
    } else {
      console.log(`Index "${name}": READY.`);
    }
  }

  const embedding = await embedText("memory v2 verification probe");
  if (!embedding) {
    console.error("embedText() returned null - check GEMINI_API_KEY and the embedding model id (see embeddings.ts).");
    ok = false;
  } else {
    console.log(`embedText() succeeded (${embedding.length}-dim vector).`);
  }

  if (!ok) {
    console.error("memory:verify FAILED - do not enable MEMORY_V2_ENABLED yet.");
    process.exit(1);
  }
  console.log("memory:verify passed.");
  process.exit(0);
}

main().catch((error) => {
  console.error("verifyMemoryV2 failed:", error);
  process.exit(1);
});
