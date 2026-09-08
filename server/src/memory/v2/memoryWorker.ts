import { randomUUID } from "node:crypto";
import { embedTextBatch } from "../embeddings.js";
import { silentModelId } from "../../silentModel.js";
import { DEFAULT_TENANT_ID } from "../../constants.js";
import type { MemoryEventRecord, MemoryItemScope, MemoryProvenance } from "../types.js";
import { memoryConsolidator, type MemoryConsolidator } from "./consolidator.js";
import { buildEpisodeDetails, episodeContent } from "./episodeBuilder.js";
import { EXTRACTOR_VERSION, memoryExtractor, type MemoryExtractor } from "./extractor.js";
import { memoryMetrics } from "./metrics.js";
import { proceduralMemoryService, type ProceduralMemoryService } from "./proceduralMemory.js";
import { memoryRepository, type MemoryRepository } from "./repository.js";
import { memorySummarizer, type MemorySummarizer } from "./summarizer.js";
import { kindForSubtype } from "./taxonomy.js";

const BATCH_MAX_EVENTS = 10;
const BATCH_MAX_CHARS = 12_000;
const ELIGIBLE_MIN_TURNS = 3;
const ELIGIBLE_MAX_AGE_MS = 5 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMBED_BATCH_SIZE = 20;

/** Lifecycle sweep cadence and per-run cap. Hourly rather than per-tick because expiry is a
 * days-to-months concern - running it on every 5s poll would be a pointless query. */
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const EXPIRY_SWEEP_LIMIT = 200;

/** How often the poll loop logs a metrics snapshot - frequent enough to catch a stuck worker in a
 * reasonable time, infrequent enough not to spam logs on a busy queue processing every tick. */
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

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

/**
 * True only for episode-worthy turns: real tool usage or a goal step. A plain greeting or Q&A
 * never becomes an episode.
 *
 * Note there is deliberately no separate tool-error branch: any errored tool call implies
 * toolSummaries is non-empty, so such a branch is unreachable (it was, previously). Tool failure
 * instead raises the episode's *importance* below, which is what it should have been doing.
 */
function isEpisodeWorthy(event: MemoryEventRecord): boolean {
  return event.toolSummaries.length > 0 || event.goalId !== null;
}

/**
 * Polls memory_events for eligible batches, leases them, and runs extraction -> policy ->
 * consolidation -> embedding -> episode creation -> summary refresh, plus a periodic lifecycle
 * sweep. Deployed as its own process (npm run memory:worker). Safe to run multiple replicas:
 * memory_worker_locks + the per-event lease fields on memory_events serialize per tenant/user/thread.
 *
 * A single tenant (DEFAULT_TENANT_ID) is polled today, but every query is tenant-scoped rather than
 * assuming it - findEligibleGroup/leaseEventsForGroup/acquireLock/releaseLock all take an explicit
 * tenantId now instead of the group's own userId/threadId alone. Previously the lease/lock queries
 * carried no tenant filter at all, which was harmless only because exactly one tenant existed.
 */
export class MemoryWorker {
  readonly ownerId = randomUUID();
  private lastExpirySweepAt = 0;
  private lastHeartbeatAt = 0;
  private stopping = false;

  constructor(
    private readonly repo: MemoryRepository = memoryRepository,
    private readonly extractor: MemoryExtractor = memoryExtractor,
    private readonly consolidator: MemoryConsolidator = memoryConsolidator,
    private readonly summarizer: MemorySummarizer = memorySummarizer,
    private readonly proceduralMemory: ProceduralMemoryService = proceduralMemoryService,
  ) {}

  /** Requests that runForever's poll loop exit once its current tick finishes, rather than
   * stopping mid-batch - a batch already holds its lock/lease and should be allowed to complete
   * (or fail cleanly through the normal per-event failure path) rather than being torn down
   * partway through. Idempotent; safe to call from a signal handler. */
  requestStop(): void {
    this.stopping = true;
  }

  /** Runs at most one eligible batch to completion for this tenant; returns whether it found and
   * processed one - callers loop this in a poll cycle. A batch's own per-event failures are
   * handled via failEvent's retry/backoff/dead path; nothing here fails the whole batch together. */
  async tick(tenantId: string): Promise<boolean> {
    await this.sweepExpiredIfDue();

    const group = await this.repo.findEligibleGroup(tenantId, ELIGIBLE_MIN_TURNS, ELIGIBLE_MAX_AGE_MS);
    if (!group) return false;

    const gotLock = await this.repo.acquireLock(tenantId, group.userId, group.threadId, this.ownerId, LEASE_MS);
    if (!gotLock) return false;

    try {
      const leased = await this.repo.leaseEventsForGroup(tenantId, group.userId, group.threadId, this.ownerId, LEASE_MS, BATCH_MAX_EVENTS);
      const events = tookTooLong(leased);
      if (events.length === 0) return false;

      await this.processBatch(events);
      return true;
    } finally {
      await this.repo.releaseLock(tenantId, group.userId, group.threadId, this.ownerId);
    }
  }

  /** Expires items whose validTo has passed. Self-contained and best-effort: a sweep failure must
   * never stop event processing, since the two are independent concerns. */
  private async sweepExpiredIfDue(): Promise<void> {
    if (Date.now() - this.lastExpirySweepAt < EXPIRY_SWEEP_INTERVAL_MS) return;
    this.lastExpirySweepAt = Date.now();
    try {
      const expired = await this.repo.expireStaleItems(EXPIRY_SWEEP_LIMIT);
      if (expired > 0) {
        console.log(`MemoryWorker: expired ${expired} stale memory item(s).`);
        memoryMetrics.increment("lifecycle_items_expired", expired);
      }
    } catch (error) {
      console.error("MemoryWorker.sweepExpiredIfDue failed - will retry on the next interval:", error);
    }
  }

  /**
   * Extraction, consolidation, episode creation and procedural-memory derivation for one leased
   * batch. Failures are isolated *per event* rather than failing the batch as a whole: a single
   * candidate or event whose consolidation throws is recorded via failEvent (with backoff) for
   * just the event(s) it came from, while every other event in the same batch still completes
   * normally. Previously any error here caught the whole batch and dead-lettered every event in it
   * together, so one poison event could burn out several healthy ones alongside it.
   */
  private async processBatch(events: MemoryEventRecord[]): Promise<void> {
    const first = events[0];
    const tenantId = first.tenantId;
    const userId = first.userId;
    // A batch is, by construction, all events for one user+thread - the workspace at the time of
    // the *latest* turn in the batch is what new items get scoped to.
    const latest = events[events.length - 1];
    const scope: MemoryItemScope = latest.workspaceId ? "workspace" : "user";
    const workspaceId = latest.workspaceId;
    const allEventIds = events.map((e) => e.id);
    const failedEventIds = new Set<string>();

    const candidates = await this.extractor.extractFromEvents(events);
    const extractedAt = new Date();
    const extractionModel = silentModelId();

    for (const candidate of candidates) {
      // Attribute the candidate to the single turn that stated it where the extractor said so,
      // falling back to the whole batch when it didn't. Previously every candidate claimed all
      // of the batch's events as sources, which both over-stated provenance and made
      // thread-deletion cleanup coarser than it needed to be.
      const attributed = candidate.sourceTurn !== undefined ? [events[candidate.sourceTurn - 1]].filter(Boolean) : events;
      const sourceEvents = attributed.length > 0 ? attributed : events;

      const provenance: MemoryProvenance = {
        sourceType: "extraction",
        actorType: "worker",
        actorId: userId,
        sourceThreadId: first.threadId,
        sourceGoalId: sourceEvents.find((e) => e.goalId !== null)?.goalId ?? null,
        sourceTurnIds: sourceEvents.map((e) => e.turnId),
        extractedAt,
        extractionModel,
        extractionVersion: EXTRACTOR_VERSION,
      };

      try {
        await this.consolidator.consolidate({
          tenantId,
          userId,
          scope,
          workspaceId,
          candidate: { ...candidate, kind: kindForSubtype(candidate.subtype) },
          sourceEventIds: sourceEvents.map((e) => e.id),
          provenance,
        });
      } catch (error) {
        console.error(`MemoryWorker: consolidation failed for candidate "${candidate.canonicalKey}":`, error);
        memoryMetrics.increment("consolidation_errors");
        for (const e of sourceEvents) failedEventIds.add(e.id);
      }
    }

    for (const event of events) {
      if (!isEpisodeWorthy(event)) continue;

      // Structured situation/objective/action/outcome/failure/resolution/lesson, derived
      // deterministically from the event - see episodeBuilder.ts. Previously an episode's
      // `content` was just `event.assistantText` verbatim, with no structure behind it at all.
      const episode = buildEpisodeDetails(event);
      const episodeProvenance: MemoryProvenance = {
        // Episodes are derived deterministically from the event record, not proposed by the
        // extractor - so they carry no extraction model/version.
        sourceType: "extraction",
        actorType: "worker",
        actorId: userId,
        sourceThreadId: event.threadId,
        sourceGoalId: event.goalId,
        sourceTurnIds: [event.turnId],
        extractedAt,
        extractionModel: null,
        extractionVersion: null,
      };

      try {
        await this.consolidator.consolidate({
          tenantId,
          userId,
          scope,
          workspaceId,
          candidate: {
            kind: "episodic",
            subtype: "episode",
            canonicalKey: `episode.${event.turnId}`,
            subject: userId,
            predicate: event.goalId ? "completed_goal_step" : "used_tools",
            object: event.turnId,
            content: episodeContent(episode),
            confidence: 1,
            importance: episode.failed ? 0.7 : 0.4,
            episode,
          },
          sourceEventIds: [event.id],
          provenance: episodeProvenance,
        });
      } catch (error) {
        console.error(`MemoryWorker: episode consolidation failed for event ${event.id}:`, error);
        memoryMetrics.increment("consolidation_errors");
        failedEventIds.add(event.id);
      }

      // Procedural memory is confined to workspace scope (taxonomy.ts) - a procedure is a
      // shared, reusable asset, not a personal one - so a user-scoped thread (no workspace)
      // never contributes candidates. This is a deliberate limitation, not an oversight: without
      // it, "how this specific person once did something" would masquerade as a validated,
      // shareable procedure.
      if (workspaceId && event.toolSummaries.length >= 2) {
        try {
          await this.proceduralMemory.recordOutcome({
            tenantId,
            userId,
            scope: "workspace",
            workspaceId,
            toolSequence: event.toolSummaries.map((t) => t.toolName),
            success: !episode.failed,
            sourceEventId: event.id,
            provenance: episodeProvenance,
          });
        } catch (error) {
          // Procedure derivation is best-effort on top of an episode that was (or wasn't) already
          // recorded above - its own failure must never fail the event that triggered it.
          console.error(`MemoryWorker: procedural memory derivation failed for event ${event.id}:`, error);
        }
      }
    }

    const succeededEventIds = allEventIds.filter((id) => !failedEventIds.has(id));
    await this.repo.markEventsDone(succeededEventIds);
    for (const id of failedEventIds) {
      await this.repo.failEvent(id, "consolidation failed - see worker logs for the candidate/event detail", MAX_ATTEMPTS);
    }

    await this.embedPendingItems();
    // Summaries reflect whatever succeeded this batch even if some events failed alongside it -
    // still self-contained/best-effort, so a summary failure never re-fails an event that just
    // succeeded above.
    await this.refreshSummaries(tenantId, userId, first.threadId, workspaceId, events);
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

  private logHeartbeatIfDue(): void {
    if (Date.now() - this.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeatAt = Date.now();
    console.log(`MemoryWorker heartbeat (ownerId=${this.ownerId}):`, memoryMetrics.getSnapshot());
  }

  /**
   * Poll loop for the standalone worker process - see scripts/runMemoryWorker.ts, which installs
   * the SIGTERM/SIGINT handlers that call requestStop(). Polls each tenant in `tenantIds` once per
   * cycle - just the single configured tenant today, but the loop itself no longer assumes there
   * is only one. Resolves (rather than never returning) once requestStop() has been called and the
   * in-flight tick has finished - previously this process had no shutdown path at all, so every
   * ordinary restart/redeploy killed it mid-batch and stranded whatever it was leasing.
   */
  async runForever(pollIntervalMs = 5000, tenantIds: string[] = [DEFAULT_TENANT_ID]): Promise<void> {
    while (!this.stopping) {
      let processed = false;
      for (const tenantId of tenantIds) {
        if (this.stopping) break;
        try {
          if (await this.tick(tenantId)) processed = true;
        } catch (error) {
          console.error(`MemoryWorker.tick threw unexpectedly for tenant ${tenantId} - continuing the poll loop:`, error);
        }
      }
      this.logHeartbeatIfDue();
      if (this.stopping) break;
      await new Promise((resolve) => setTimeout(resolve, processed ? 0 : pollIntervalMs));
    }
    console.log(`MemoryWorker (ownerId=${this.ownerId}): stopped gracefully.`);
  }
}

export const memoryWorker = new MemoryWorker();
