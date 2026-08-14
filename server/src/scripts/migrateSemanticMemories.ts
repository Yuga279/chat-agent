import { connectDb, getDb } from "../db.js";

/**
 * One-off migration for the memories -> semantic_memories rename:
 * 1. Renames the `memories` collection to `semantic_memories` (skipped if `memories` doesn't
 *    exist, e.g. a fresh dev DB that was never written to).
 * 2. Remaps any documents with `type: "preference"` to `type: "semantic"`, since MemoryType
 *    no longer distinguishes preferences as a separate category.
 *
 * Safe to run more than once: renaming a non-existent collection is a no-op, and the
 * `updateMany` filter only matches documents still tagged "preference".
 *
 * Run with: node --env-file=.env dist/scripts/migrateSemanticMemories.js
 */
async function main(): Promise<void> {
  await connectDb();
  const db = getDb();

  const collections = await db.listCollections({ name: "memories" }).toArray();
  if (collections.length > 0) {
    await db.renameCollection("memories", "semantic_memories");
    console.log("Renamed collection 'memories' -> 'semantic_memories'.");
  } else {
    console.log("No 'memories' collection found; skipping rename.");
  }

  const result = await db
    .collection("semantic_memories")
    .updateMany({ type: "preference" }, { $set: { type: "semantic" } });
  console.log(`Remapped ${result.modifiedCount} document(s) from type "preference" to "semantic".`);

  process.exit(0);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
