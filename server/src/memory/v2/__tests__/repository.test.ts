import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCollection } from "./inMemoryMongo.js";
import { extractionProvenance } from "./fixtures.js";
import type { MemoryItemRecord, MemoryRevisionRecord } from "../../types.js";

const items = new InMemoryCollection<MemoryItemRecord>();
const revisions = new InMemoryCollection<MemoryRevisionRecord>();
const summaries = new InMemoryCollection();
const events = new InMemoryCollection();
const locks = new InMemoryCollection();

// Swapping the collection accessors lets the *real* MemoryRepository methods run end to end.
vi.mock("../../collections.js", () => ({
  NO_ID_PROJECTION: { projection: { _id: 0 } },
  memoryItemsCollection: () => items,
  memoryRevisionsCollection: () => revisions,
  memorySummariesCollection: () => summaries,
  memoryEventsCollection: () => events,
  memoryWorkerLocksCollection: () => locks,
}));

const { MemoryRepository } = await import("../repository.js");

function baseUpsert(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "default",
    userId: "u1",
    scope: "user" as const,
    workspaceId: null,
    kind: "semantic" as const,
    subtype: "fact" as const,
    canonicalKey: "user.timezone",
    subject: "user",
    predicate: "timezone",
    object: "Asia/Kolkata",
    content: "user timezone: Asia/Kolkata",
    confidence: 0.9,
    importance: 0.7,
    sensitivity: "none" as const,
    sourceEventIds: ["evt1"],
    provenance: extractionProvenance(),
    existing: null,
    revisionAction: "extracted" as const,
    ...overrides,
  };
}

describe("MemoryRepository.upsertByCanonicalKey", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    items.reset();
    revisions.reset();
    repo = new MemoryRepository();
  });

  it("creates the first item at version 1 with no supersession links", async () => {
    const item = await repo.upsertByCanonicalKey(baseUpsert());

    expect(item.version).toBe(1);
    expect(item.status).toBe("active");
    expect(item.supersedes).toBeNull();
    expect(item.supersededBy).toBeNull();
    expect(item.embeddingStatus).toBe("pending");
  });

  it("records an audit row naming the actor that wrote it", async () => {
    const item = await repo.upsertByCanonicalKey(baseUpsert());

    const written = revisions.docs.filter((r) => r.itemId === item.id);
    expect(written).toHaveLength(1);
    expect(written[0].action).toBe("extracted");
    expect(written[0].actorType).toBe("worker");
    expect(written[0].actorId).toBe("u1");
  });

  it("leaves the superseded item's own backward pointer intact", async () => {
    // Regression test for the defect this replaced: supersedeItem used to write the *successor*
    // id into the old item's `supersedes` field, overwriting its link to its own predecessor. That
    // made the version chain unwalkable past one hop, and the previous test suite could not catch
    // it because its fake repository reimplemented this method.
    const v1 = await repo.upsertByCanonicalKey(baseUpsert());
    const v2 = await repo.upsertByCanonicalKey(baseUpsert({ object: "America/New_York", existing: v1 }));
    const v3 = await repo.upsertByCanonicalKey(baseUpsert({ object: "Europe/Berlin", existing: v2 }));

    const stored = (id: string) => items.docs.find((d) => d.id === id)!;

    // Forward links point at successors.
    expect(stored(v1.id).supersededBy).toBe(v2.id);
    expect(stored(v2.id).supersededBy).toBe(v3.id);
    expect(stored(v3.id).supersededBy).toBeNull();

    // Backward links still point at predecessors - not clobbered by the forward write.
    expect(stored(v1.id).supersedes).toBeNull();
    expect(stored(v2.id).supersedes).toBe(v1.id);
    expect(stored(v3.id).supersedes).toBe(v2.id);
  });

  it("increments the version across a supersession chain and keeps only the newest active", async () => {
    const v1 = await repo.upsertByCanonicalKey(baseUpsert());
    const v2 = await repo.upsertByCanonicalKey(baseUpsert({ object: "America/New_York", existing: v1 }));
    const v3 = await repo.upsertByCanonicalKey(baseUpsert({ object: "Europe/Berlin", existing: v2 }));

    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);

    const active = items.docs.filter((d) => d.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(v3.id);
    expect(items.docs.filter((d) => d.status === "superseded")).toHaveLength(2);
  });

  it("assigns an expiry only to subtypes that carry a TTL", async () => {
    const fact = await repo.upsertByCanonicalKey(baseUpsert());
    expect(fact.validTo).toBeNull();

    const episode = await repo.upsertByCanonicalKey(
      baseUpsert({ kind: "episodic", subtype: "episode", canonicalKey: "episode.turn-9" }),
    );
    expect(episode.validTo).toBeInstanceOf(Date);
    expect(episode.validTo!.getTime()).toBeGreaterThan(episode.validFrom.getTime());
  });

  it("refuses a write whose scope the taxonomy disallows", async () => {
    await expect(
      repo.upsertByCanonicalKey(
        baseUpsert({ kind: "procedural", subtype: "procedure", scope: "user", canonicalKey: "procedure.deploy" }),
      ),
    ).rejects.toThrow(/may not be written at scope/);

    // Nothing partially written.
    expect(items.docs).toHaveLength(0);
    expect(revisions.docs).toHaveLength(0);
  });

  it("refuses a subtype that does not belong to its kind", async () => {
    await expect(
      repo.upsertByCanonicalKey(baseUpsert({ kind: "episodic", subtype: "fact" })),
    ).rejects.toThrow(/does not belong to kind/);
  });
});

describe("MemoryRepository.reinforceItem", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    items.reset();
    revisions.reset();
    repo = new MemoryRepository();
  });

  it("raises confidence and importance without creating a new version", async () => {
    const v1 = await repo.upsertByCanonicalKey(baseUpsert({ confidence: 0.7, importance: 0.5 }));

    const reinforced = await repo.reinforceItem(v1, { confidence: 0.95, importance: 0.8, sourceEventIds: ["evt2"] });

    expect(reinforced.confidence).toBe(0.95);
    expect(reinforced.importance).toBe(0.8);
    expect(reinforced.version).toBe(1);
    expect(items.docs).toHaveLength(1);
    expect(items.docs[0].sourceEventIds).toEqual(["evt1", "evt2"]);
  });

  it("never weakens what is already on file", async () => {
    // A restatement is corroboration. A lower incoming confidence must not downgrade the record,
    // or repeating a fact less certainly would erode it.
    const v1 = await repo.upsertByCanonicalKey(baseUpsert({ confidence: 0.9, importance: 0.8 }));

    const reinforced = await repo.reinforceItem(v1, { confidence: 0.4, importance: 0.1, sourceEventIds: [] });

    expect(reinforced.confidence).toBe(0.9);
    expect(reinforced.importance).toBe(0.8);
  });

  it("records a consolidated revision rather than a supersession", async () => {
    const v1 = await repo.upsertByCanonicalKey(baseUpsert());
    revisions.reset();

    await repo.reinforceItem(v1, { confidence: 0.95, importance: 0.8, sourceEventIds: [] });

    expect(revisions.docs).toHaveLength(1);
    expect(revisions.docs[0].action).toBe("consolidated");
  });
});

describe("MemoryRepository.expireStaleItems", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    items.reset();
    revisions.reset();
    repo = new MemoryRepository();
  });

  it("expires items whose validTo has passed and records why", async () => {
    const episode = await repo.upsertByCanonicalKey(
      baseUpsert({ kind: "episodic", subtype: "episode", canonicalKey: "episode.old" }),
    );

    // Well past the episode TTL.
    const later = new Date(episode.validTo!.getTime() + 1000);
    const count = await repo.expireStaleItems(50, later);

    expect(count).toBe(1);
    expect(items.docs.find((d) => d.id === episode.id)!.status).toBe("expired");

    const revision = revisions.docs.find((r) => r.action === "expired");
    expect(revision).toBeDefined();
    expect(revision!.itemId).toBe(episode.id);
    expect(revision!.actorType).toBe("worker");
  });

  it("leaves items with no expiry alone", async () => {
    const fact = await repo.upsertByCanonicalKey(baseUpsert());

    const count = await repo.expireStaleItems(50, new Date("2099-01-01T00:00:00Z"));

    expect(count).toBe(0);
    expect(items.docs.find((d) => d.id === fact.id)!.status).toBe("active");
  });

  it("does not re-expire an already-expired item", async () => {
    const episode = await repo.upsertByCanonicalKey(
      baseUpsert({ kind: "episodic", subtype: "episode", canonicalKey: "episode.old" }),
    );
    const later = new Date(episode.validTo!.getTime() + 1000);

    await repo.expireStaleItems(50, later);
    const second = await repo.expireStaleItems(50, later);

    expect(second).toBe(0);
    expect(revisions.docs.filter((r) => r.action === "expired")).toHaveLength(1);
  });

  it("honours its batch limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await repo.upsertByCanonicalKey(
        baseUpsert({ kind: "episodic", subtype: "episode", canonicalKey: `episode.${i}` }),
      );
    }

    const count = await repo.expireStaleItems(2, new Date("2099-01-01T00:00:00Z"));

    expect(count).toBe(2);
  });
});

describe("MemoryRepository.recordRejection", () => {
  beforeEach(() => {
    items.reset();
    revisions.reset();
  });

  it("audits a refused candidate with no item id, since no item exists", async () => {
    const repo = new MemoryRepository();

    await repo.recordRejection(
      "default",
      "u1",
      {
        subject: "user",
        predicate: "card_number",
        object: "4111 1111 1111 1111",
        content: "user card_number: 4111 1111 1111 1111",
        canonicalKey: "user.card_number",
        confidence: 0.95,
      },
      "policy: sensitive content may not be auto-captured",
    );

    expect(items.docs).toHaveLength(0);
    expect(revisions.docs).toHaveLength(1);
    expect(revisions.docs[0].action).toBe("rejected");
    expect(revisions.docs[0].itemId).toBeNull();
    expect(revisions.docs[0].reason).toMatch(/sensitive/);
  });
});

function seedEvent(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const event = {
    id: overrides.id ?? `evt-${events.docs.length}`,
    tenantId: "default",
    userId: "u1",
    threadId: "t1",
    workspaceId: null,
    turnId: `turn-${events.docs.length}`,
    userText: "hi",
    assistantText: "hello",
    toolSummaries: [],
    goalId: null,
    stepIndex: null,
    status: "pending",
    attempts: 0,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  events.docs.push(event as never);
  return event;
}

describe("MemoryRepository.findEligibleGroup / leaseEventsForGroup", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    events.reset();
    repo = new MemoryRepository();
  });

  it("finds a group once it reaches the minimum turn count", async () => {
    seedEvent({ id: "e1" });
    seedEvent({ id: "e2" });
    const group = await repo.findEligibleGroup("default", 3, 5 * 60 * 1000);
    expect(group).toBeNull(); // only 2 events, below minTurns=3

    seedEvent({ id: "e3" });
    const found = await repo.findEligibleGroup("default", 3, 5 * 60 * 1000);
    expect(found).toEqual({ userId: "u1", threadId: "t1" });
  });

  it("never groups events from a different tenant together", async () => {
    // Regression test: findEligibleGroup used to have no tenantId in its match/group at all, so a
    // second tenant's events under a colliding userId could in principle be grouped with this one.
    seedEvent({ id: "e1", tenantId: "tenant-a" });
    seedEvent({ id: "e2", tenantId: "tenant-a" });
    seedEvent({ id: "e3", tenantId: "tenant-b" });

    const groupA = await repo.findEligibleGroup("tenant-a", 2, 5 * 60 * 1000);
    expect(groupA).toEqual({ userId: "u1", threadId: "t1" });

    const groupB = await repo.findEligibleGroup("tenant-b", 2, 5 * 60 * 1000);
    expect(groupB).toBeNull(); // tenant-b only has 1 event, below minTurns=2 on its own
  });

  it("reclaims a lease abandoned by a crashed worker", async () => {
    // Regression test for C1: "processing" was written once (on lease) and read by nothing, so a
    // worker killed mid-batch stranded its events there forever.
    seedEvent({
      id: "stuck",
      status: "processing",
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 1000), // expired a second ago
    });

    const group = await repo.findEligibleGroup("default", 1, 5 * 60 * 1000);
    expect(group).toEqual({ userId: "u1", threadId: "t1" });

    const leased = await repo.leaseEventsForGroup("default", "u1", "t1", "new-worker", 5 * 60 * 1000, 10);
    expect(leased.map((e) => e.id)).toEqual(["stuck"]);
    expect(events.docs[0].leaseOwner).toBe("new-worker");
  });

  it("does not reclaim a lease that hasn't expired yet", async () => {
    seedEvent({
      id: "in-flight",
      status: "processing",
      leaseOwner: "live-worker",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const leased = await repo.leaseEventsForGroup("default", "u1", "t1", "other-worker", 5 * 60 * 1000, 10);
    expect(leased).toHaveLength(0);
  });

  it("respects a backoff gate on a pending event that failed recently", async () => {
    seedEvent({ id: "backing-off", nextAttemptAt: new Date(Date.now() + 60_000) });

    const leased = await repo.leaseEventsForGroup("default", "u1", "t1", "worker", 5 * 60 * 1000, 10);
    expect(leased).toHaveLength(0);
  });

  it("leases a pending event once its backoff gate has passed", async () => {
    seedEvent({ id: "ready", nextAttemptAt: new Date(Date.now() - 1000) });

    const leased = await repo.leaseEventsForGroup("default", "u1", "t1", "worker", 5 * 60 * 1000, 10);
    expect(leased.map((e) => e.id)).toEqual(["ready"]);
  });
});

describe("MemoryRepository.failEvent", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    events.reset();
    repo = new MemoryRepository();
  });

  it("sets a future nextAttemptAt on a retryable failure, not an immediately-eligible one", async () => {
    // Regression test for H2: previously a failed event went straight back to "pending" with
    // leaseExpiresAt cleared and no backoff at all, so it (and every other event failed alongside
    // it) was immediately re-eligible on the very next poll.
    seedEvent({ id: "e1" });

    await repo.failEvent("e1", "boom", 5);

    const stored = events.docs[0];
    expect(stored.status).toBe("pending");
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt).toBeInstanceOf(Date);
    expect((stored.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("increases the backoff delay with each successive attempt", async () => {
    seedEvent({ id: "e1" });

    await repo.failEvent("e1", "boom", 10);
    const firstDelay = (events.docs[0].nextAttemptAt as Date).getTime() - Date.now();

    await repo.failEvent("e1", "boom again", 10);
    const secondDelay = (events.docs[0].nextAttemptAt as Date).getTime() - Date.now();

    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it("marks an event dead once maxAttempts is exhausted, with no further backoff", async () => {
    seedEvent({ id: "e1", attempts: 4 });

    await repo.failEvent("e1", "final failure", 5);

    const stored = events.docs[0];
    expect(stored.status).toBe("dead");
    expect(stored.attempts).toBe(5);
    expect(stored.nextAttemptAt).toBeNull();
  });
});

describe("MemoryRepository.setEmbedding", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    items.reset();
    repo = new MemoryRepository();
  });

  it("clears the attempt counter on success", async () => {
    const item = await repo.upsertByCanonicalKey(baseUpsert());
    await repo.setEmbedding(item.id, [0.1, 0.2]);

    const stored = items.docs.find((d) => d.id === item.id)!;
    expect(stored.embeddingStatus).toBe("done");
    expect(stored.embeddingAttempts).toBe(0);
    expect(stored.embedding).toEqual([0.1, 0.2]);
  });

  it("stays pending (auto-retried) on a failure below the attempt cap", async () => {
    // Regression test for C8: previously a *single* failure jumped straight to the terminal
    // "failed" status, so any transient embedding hiccup permanently removed the item from vector
    // retrieval. listPendingEmbeddings only ever selects "pending", so staying pending here is
    // exactly what makes the item retry on the worker's next embedPendingItems() pass.
    const item = await repo.upsertByCanonicalKey(baseUpsert());

    await repo.setEmbedding(item.id, null);

    const stored = items.docs.find((d) => d.id === item.id)!;
    expect(stored.embeddingStatus).toBe("pending");
    expect(stored.embeddingAttempts).toBe(1);
  });

  it("becomes terminally failed only after repeated consecutive failures", async () => {
    const item = await repo.upsertByCanonicalKey(baseUpsert());

    for (let i = 0; i < 4; i += 1) {
      await repo.setEmbedding(item.id, null);
      expect(items.docs.find((d) => d.id === item.id)!.embeddingStatus).toBe("pending");
    }
    await repo.setEmbedding(item.id, null); // 5th consecutive failure

    const stored = items.docs.find((d) => d.id === item.id)!;
    expect(stored.embeddingStatus).toBe("failed");
    expect(stored.embeddingAttempts).toBe(5);
  });

  it("recovers a previously-struggling item once an embedding finally succeeds", async () => {
    const item = await repo.upsertByCanonicalKey(baseUpsert());
    await repo.setEmbedding(item.id, null);
    await repo.setEmbedding(item.id, null);

    await repo.setEmbedding(item.id, [0.5]);

    const stored = items.docs.find((d) => d.id === item.id)!;
    expect(stored.embeddingStatus).toBe("done");
    expect(stored.embeddingAttempts).toBe(0);
  });
});

describe("MemoryRepository.listItems", () => {
  let repo: InstanceType<typeof MemoryRepository>;

  beforeEach(() => {
    items.reset();
    repo = new MemoryRepository();
  });

  it("never returns the embedding field", async () => {
    const item = await repo.upsertByCanonicalKey(baseUpsert());
    await repo.setEmbedding(item.id, [0.1, 0.2, 0.3]);

    const { items: results } = await repo.listItems("default", "u1");

    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty("embedding");
  });

  it("paginates and reports whether more pages remain", async () => {
    for (let i = 0; i < 5; i += 1) {
      const item = await repo.upsertByCanonicalKey(baseUpsert({ canonicalKey: `user.fact${i}` }));
      // Force a distinct, strictly increasing updatedAt per item - back-to-back calls against this
      // in-memory double are fast enough to otherwise land on the same millisecond, which would
      // make cursor-based pagination's ordering (and this test) nondeterministic.
      items.docs.find((d) => d.id === item.id)!.updatedAt = new Date(Date.now() + i * 1000);
    }

    const page1 = await repo.listItems("default", "u1", {}, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    // Walk every page via the returned cursor rather than asserting an exact per-page split -
    // items written in a tight loop can legitimately share a millisecond-resolution updatedAt, so
    // pinning down exactly which items land on which page would be asserting Date precision, not
    // pagination behavior. What must hold regardless: every item is seen exactly once, and the
    // walk terminates.
    const seen = new Set(page1.items.map((i) => i.id));
    let cursor = page1.items[page1.items.length - 1].updatedAt;
    let hasMore = page1.hasMore;
    let guard = 0;
    while (hasMore && guard < 10) {
      const page = await repo.listItems("default", "u1", {}, { limit: 2, before: cursor });
      for (const item of page.items) seen.add(item.id);
      cursor = page.items[page.items.length - 1]?.updatedAt ?? cursor;
      hasMore = page.hasMore;
      guard += 1;
    }
    expect(seen.size).toBe(5);
  });

  it("clamps an oversized limit request", async () => {
    await repo.upsertByCanonicalKey(baseUpsert());
    const { items: results } = await repo.listItems("default", "u1", {}, { limit: 10_000 });
    expect(results).toHaveLength(1); // doesn't throw, just clamps - only one item exists anyway
  });
});
