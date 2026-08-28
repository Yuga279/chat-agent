import { connectDb, getDb } from "../db.js";
import { ensureMemoryV2Indexes } from "../memory/collections.js";

const EMBEDDING_DIMENSIONS = 3072; // gemini-embedding-001

/**
 * Privileged, one-off deployment step - separate from the ordinary indexes ensureMemoryV2Indexes()
 * creates automatically at every startup. Atlas Search/Vector Search index management requires
 * Atlas (not a plain self-hosted MongoDB), so this is never called from application code.
 *
 * Run with: node --env-file=.env dist/scripts/provisionMemoryIndexes.js
 */
async function main(): Promise<void> {
  await connectDb();
  await ensureMemoryV2Indexes();

  const db = getDb();
  const memoryItems = db.collection("memory_items");

  const existing = await memoryItems.listSearchIndexes().toArray();
  const existingNames = new Set(existing.map((i) => i.name));

  if (!existingNames.has("memory-items-vector")) {
    await memoryItems.createSearchIndex({
      name: "memory-items-vector",
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
          { type: "filter", path: "tenantId" },
          { type: "filter", path: "userId" },
          { type: "filter", path: "workspaceId" },
          { type: "filter", path: "status" },
          { type: "filter", path: "kind" },
        ],
      },
    });
    console.log("Created Atlas Vector Search index 'memory-items-vector'.");
  } else {
    console.log("Atlas Vector Search index 'memory-items-vector' already exists; skipping.");
  }

  if (!existingNames.has("memory-items-text")) {
    await memoryItems.createSearchIndex({
      name: "memory-items-text",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            canonicalKey: { type: "string" },
            content: { type: "string" },
            tenantId: { type: "token" },
            userId: { type: "token" },
            workspaceId: { type: "token" },
            status: { type: "token" },
            kind: { type: "token" },
          },
        },
      },
    });
    console.log("Created Atlas Search index 'memory-items-text'.");
  } else {
    console.log("Atlas Search index 'memory-items-text' already exists; skipping.");
  }

  console.log("Note: Atlas Search/Vector Search indexes build asynchronously - re-run memory:verify " +
    "after a minute or two to confirm they're queryable, not just created.");
  process.exit(0);
}

main().catch((error) => {
  console.error("provisionMemoryIndexes failed:", error);
  process.exit(1);
});
