import { randomUUID } from "node:crypto";
import { embedTextBatch } from "../embeddings.js";
import { DEFAULT_TENANT_ID } from "../../constants.js";
import type { MemoryEventRecord, MemoryItemScope } from "../types.js";
import { memoryConsolidator, type MemoryConsolidator } from "./consolidator.js";
import { memoryExtractor, type MemoryExtractor } from "./extractor.js";
import { memoryRepository, type MemoryRepository } from "./repository.js";
import { memorySummarizer, type MemorySummarizer } from "./summarizer.js";

const BATCH_MAX_EVENTS = 10;
const BATCH_MAX_CHARS = 12_000;
const ELIGIBLE_MIN_TURNS = 3;
const ELIGIBLE_MAX_AGE_MS = 5 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMBED_BATCH_SIZE = 20;

function tookTooLong(events: MemoryEventRecord[]): MemoryEventRecord[] {
  let chars = 0;
  const kept: MemoryEventRecord[] = [];
  for (const e of events) {
    const len = e.userText.length + e.assistantText.length;
    if (kept.length > 0 && chars + len > BATCH_MAX_CHARS) break;
    kept.push(e);
    chars += len;
    if (kept.length >= BATCH_MAX_EVENTS) break;
  }
  return kept;
}

/** True only for episode-worthy turns: real tool usage, a completed goal step, a material
 * failure, or explicit user feedback about how something went - never a plain greeting/Q&A. */
function isEpisodeWorthy(event: MemoryEventRecord): boolean {
  if (event.toolSummaries.length > 0) return true;
  if (event.goalId !== null) return true;
  if (event.toolSummaries.some((t) => t.status === "error")) return true;
  return false;
}

/**
 * Polls memory_events for eligible batches, leases them, and runs extraction -> policy ->
 * consolidation -> embedding -> episode creation. Deployed as its own process
 * (npm run memory:worker) - see PLAN.md's three-process model. Safe to run multiple replicas:
 * memory_worker_locks + the per-event lease fields on memory_events make processing at-least-once
 * safe, and consolidation/embedding are themselves idempotent by sourceEventIds/turnId.
 */
export class MemoryWorker {
  readonly ownerId = randomUUID();

  constructor(
    private readonly repo: MemoryRepository = memoryRepository,
    private readonly extractor: MemoryExtractor = memoryExtractor,
    private readonly consolidator: MemoryConsolidator = memoryConsolidator,
    private readonly summarizer: MemorySummarizer = memorySummarizer,
  ) {}

  /** Runs at most one eligible batch to completion; returns whether it found and processed one -
   * callers loop this in a poll cycle. Never throws: a batch's own failure is handled per-event
   * via failEvent's retry/backoff-to-dead path. */
  async tick(): Promise<boolean> {
    const group = await this.repo.findEligibleGroup(ELIGIBLE_MIN_TURNS, ELIGIBLE_MAX_AGE_MS);
    if (!group) return false;

    const gotLock = await this.repo.acquireLock(DEFAULT_TENANT_ID, group.userId, group.threadId, this.ownerId, LEASE_MS);
    if (!gotLock) return false;

    try {
      const leased = await this.repo.leaseEventsForGroup(group.userId, group.threadId, this.ownerId, LEASE_MS, BATCH_MAX_EVENTS);
      const events = tookTooLong(leased);
      if (events.length === 0) return false;

      await this.processBatch(events);
      return true;
    } finally {
      await this.repo.releaseLock(DEFAULT_TENANT_ID, group.userId, group.threadId, this.ownerId);
    }
  }

  private async processBatch(events: MemoryEventRecord[]): Promise<void> {
    const first = events[0];
    const tenantId = first.tenantId;
    const userId = first.userId;
    // A batch is, by construction, all events for one user+thread - the workspace at the time of
    // the *latest* turn in the batch is what new items get scoped to.
    const latest = events[events.length - 1];
    const scope: MemoryItemScope = latest.workspaceId ? "workspace" : "user";
    const workspaceId = latest.workspaceId;

    try {
      const candidates = await this.extractor.extractFromEvents(events);
      const sourceEventIds = events.map((e) => e.id);

      for (const candidate of candidates) {
        await this.consolidator.consolidate({ tenantId, userId, scope, workspaceId, candidate, sourceEventIds });
      }

      for (const event of events) {
        if (isEpisodeWorthy(event)) {
          await this.consolidator.consolidate({
            tenantId,
            userId,
            scope,
            workspaceId,
            candidate: {
              kind: "episode",
              canonicalKey: `episode.${event.turnId}`,
              subject: userId,
              predicate: event.goalId ? "completed_goal_step" : "used_tools",
              object: event.turnId,
              content: event.assistantText,
              confidence: 1,
              importance: event.toolSummaries.some((t) => t.status === "error") ? 0.7 : 0.4,
            },
            sourceEventIds: [event.id],
          });
        }
      }

      await this.repo.markEventsDone(sourceEventIds);
      await this.embedPendingItems();
      await this.refreshSummaries(tenantId, userId, first.threadId, workspaceId, events);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`MemoryWorker.processBatch failed for user ${userId} thread ${first.threadId}:`, error);
      for (const event of events) {
        await this.repo.failEvent(event.id, message, MAX_ATTEMPTS);
      }
    }
  }

  /** Regenerates this batch's thread recap plus the user/workspace profile cards. Called after
   * markEventsDone(), so a failure here must never re-fail events that already succeeded -
   * best-effort and self-contained, same contract as embedPendingItems(). */
  private async refreshSummaries(
    tenantId: string,
    userId: string,
    threadId: string,
    workspaceId: string | null,
    events: MemoryEventRecord[],
  ): Promise<void> {
    try {
      await this.summarizer.refreshThreadSummary(tenantId, userId, threadId, events);
      await this.summarizer.refreshProfileCard(tenantId, userId, "user", null);
      if (workspaceId) {
        await this.summarizer.refreshProfileCard(tenantId, userId, "workspace", workspaceId);
      }
    } catch (error) {
      console.error(`MemoryWorker.refreshSummaries failed for user ${userId} thread ${threadId} (batch itself already succeeded):`, error);
    }
  }

  private async embedPendingItems(): Promise<void> {
    const pending = await this.repo.listPendingEmbeddings(EMBED_BATCH_SIZE);
    if (pending.length === 0) return;

    const embeddings = await embedTextBatch(pending.map((p) => p.content));
    await Promise.all(pending.map((item, i) => this.repo.setEmbedding(item.id, embeddings[i] ?? null)));
  }

  /** Poll loop for the standalone worker process - see scripts/runMemoryWorker.ts. */
  async runForever(pollIntervalMs = 5000): Promise<never> {
    for (;;) {
      let processed = false;
      try {
        processed = await this.tick();
      } catch (error) {
        console.error("MemoryWorker.tick threw unexpectedly - continuing the poll loop:", error);
      }
      await new Promise((resolve) => setTimeout(resolve, processed ? 0 : pollIntervalMs));
    }
  }
}

export const memoryWorker = new MemoryWorker();
