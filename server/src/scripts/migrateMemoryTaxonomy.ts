import { connectDb, getDb } from "../db.js";
import { ensureMemoryV2Indexes } from "../memory/collections.js";
import { buildEpisodeDetails } from "../memory/v2/episodeBuilder.js";
import { resolveLegacyKind, expiresAtFor } from "../memory/v2/taxonomy.js";
import type { EpisodeDetails, MemoryEventRecord, MemoryItemRecord, MemoryProvenance } from "../memory/types.js";

/**
 * Backfills the taxonomy/lifecycle/provenance fields onto memory_items and memory_revisions rows
 * written before those fields existed, plus the reliability-stage additions (embedding retry
 * counter, event backoff gate) added afterward.
 *
 * Idempotent: every update is filtered on the field being absent, so re-running it is a no-op -
 * safe to run again after this file gains a new backfill block, since already-migrated rows are
 * simply skipped by each block's own existence check. Safe to run against a live database - it
 * only adds fields and never changes an item's value, status, or canonical key.
 *
 * Run with: node --env-file=.env dist/scripts/migrateMemoryTaxonomy.js
 */

/** Legacy rows have no recorded origin beyond their source events, so provenance is filled in as
 * honestly as possible: the source type says the fields were reconstructed, not observed. */
function backfilledProvenance(item: MemoryItemRecord): MemoryProvenance {
  return {
    sourceType: "extraction",
    actorType: "worker",
    actorId: item.userId,
    sourceThreadId: null,
    sourceGoalId: null,
    sourceTurnIds: [],
    extractedAt: item.createdAt ?? null,
    extractionModel: null,
    extractionVersion: null,
  };
}

async function main(): Promise<void> {
  await connectDb();

  const db = getDb();
  const items = db.collection<MemoryItemRecord>("memory_items");
  const revisions = db.collection("memory_revisions");
  const events = db.collection<MemoryEventRecord>("memory_events");

  // --- memory_items: kind/subtype, version chain, lifecycle, provenance ---------------------

  const legacyItems = await items
    .find({ $or: [{ subtype: { $exists: false } }, { version: { $exists: false } }, { provenance: { $exists: false } }] })
    .toArray();

  console.log(`memory_items: ${legacyItems.length} row(s) need backfill.`);

  let migrated = 0;
  for (const item of legacyItems) {
    // The legacy `kind` held a flat value ("fact" | "preference" | "episode") that is now split
    // into kind + subtype. Anything unrecognised falls back to semantic/fact.
    const { kind, subtype } = resolveLegacyKind(item.kind as unknown as string);

    const set: Record<string, unknown> = {};
    if (item.subtype === undefined) {
      set.kind = kind;
      set.subtype = subtype;
    }
    if (item.version === undefined) {
      // Legacy rows carry no version history, so every surviving row starts the chain at 1.
      set.version = 1;
    }
    if (item.supersededBy === undefined) {
      // The old code wrote the forward pointer into `supersedes` on superseded rows, conflating
      // the two directions. Recover it: a superseded row's `supersedes` value is in fact its
      // successor, so move it across and clear the misused backward field.
      if (item.status === "superseded" && item.supersedes) {
        set.supersededBy = item.supersedes;
        set.supersedes = null;
      } else {
        set.supersededBy = null;
      }
    }
    if (item.provenance === undefined) {
      set.provenance = backfilledProvenance(item);
    }
    // Only assign an expiry where the subtype actually has a TTL, and measure it from the item's
    // own creation date rather than now - otherwise migrating would silently reset the clock on
    // every existing episode.
    if (item.validTo === null || item.validTo === undefined) {
      const expiry = expiresAtFor(subtype, item.createdAt ?? new Date());
      if (expiry) set.validTo = expiry;
    }

    if (Object.keys(set).length === 0) continue;
    await items.updateOne({ id: item.id }, { $set: set });
    migrated += 1;
  }
  console.log(`memory_items: backfilled ${migrated} row(s).`);

  // --- memory_revisions: actor model -------------------------------------------------------

  // Pre-existing revisions have no recorded actor. "manual_edit" was only ever written by a user
  // action (the memories API or the remember_fact tool); every other legacy action came from the
  // worker's extraction/consolidation path.
  const userActed = await revisions.updateMany(
    { actorType: { $exists: false }, action: "manual_edit" },
    [{ $set: { actorType: "user", actorId: "$userId" } }],
  );
  const workerActed = await revisions.updateMany(
    { actorType: { $exists: false } },
    [{ $set: { actorType: "worker", actorId: "$userId" } }],
  );
  console.log(
    `memory_revisions: backfilled ${userActed.modifiedCount} user-acted and ${workerActed.modifiedCount} worker-acted row(s).`,
  );

  // --- memory_items: embedding retry counter (reliability stage) --------------------------

  const embeddingBackfill = await items.updateMany({ embeddingAttempts: { $exists: false } }, { $set: { embeddingAttempts: 0 } });
  console.log(`memory_items: backfilled embeddingAttempts on ${embeddingBackfill.modifiedCount} row(s).`);

  // --- memory_events: backoff gate (reliability stage) -------------------------------------

  const eventsBackfill = await events.updateMany({ nextAttemptAt: { $exists: false } }, { $set: { nextAttemptAt: null } });
  console.log(`memory_events: backfilled nextAttemptAt on ${eventsBackfill.modifiedCount} row(s).`);

  // --- memory_items: episode structure (episode-structure stage) ---------------------------

  // upsertByCanonicalKey now refuses any episodic write with no `episode` payload - existing rows
  // written before that enforcement (and before EpisodeDetails existed at all) need one backfilled
  // before anything touches them again (a reinforceItem call on an old episode, for instance).
  const legacyEpisodes = await items.find({ kind: "episodic", episode: { $exists: false } }).toArray();
  console.log(`memory_items: ${legacyEpisodes.length} episodic row(s) need structure backfill.`);

  let episodesBackfilled = 0;
  for (const item of legacyEpisodes) {
    const sourceEventId = item.sourceEventIds[0];
    const sourceEvent = sourceEventId ? await events.findOne({ id: sourceEventId }) : null;

    // Reconstruct from the original event when it still exists (the common case); when it's
    // already been cleaned up (e.g. by thread deletion), fall back to whatever the item itself
    // still carries rather than fabricating detail that was never observed.
    const episode: EpisodeDetails = sourceEvent
      ? buildEpisodeDetails(sourceEvent)
      : {
          situation: "unknown - source event no longer exists",
          objective: "unknown - source event no longer exists",
          action: [],
          outcome: item.content,
          // importance was set to 0.7 for a failed episode and 0.4 otherwise (memoryWorker.ts) -
          // the only failure signal that survives once the source event is gone.
          failed: item.importance >= 0.7,
          failedTool: null,
          resolution: null,
          lesson: null,
          goalId: null,
          stepIndex: null,
        };

    await items.updateOne({ id: item.id }, { $set: { episode } });
    episodesBackfilled += 1;
  }
  console.log(`memory_items: backfilled episode structure on ${episodesBackfilled} row(s).`);

  // Indexes last, so the new fields exist before anything is indexed on them.
  await ensureMemoryV2Indexes();
  console.log("Indexes ensured. Migration complete.");
  process.exit(0);
}

main().catch((error) => {
  console.error("migrateMemoryTaxonomy failed:", error);
  process.exit(1);
});
