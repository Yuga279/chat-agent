import { randomUUID } from "node:crypto";
import { conversationMessagesCollection, episodesCollection, memoriesCollection } from "./collections.js";
import { DefaultImportanceScorer } from "./importanceScorer.js";
import { LlmMemoryExtractor } from "./classifier.js";
import { cosineSimilarity, embedText } from "./embeddings.js";
import type {
  ConversationMessageRecord,
  EpisodeRecord,
  ExtractedFact,
  IMemoryExtractor,
  IMemoryImportanceScorer,
  MemoryRecord,
  MemorySource,
  MemoryType,
} from "./types.js";

const CONVERSATION_WINDOW = 20;
const MIN_IMPORTANCE_TO_PERSIST = 0.5;
const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

export interface RememberInput {
  tenantId: string;
  userId: string;
  type: MemoryType;
  subject: string;
  predicate: string;
  object: string;
  source: MemorySource;
  confidence: number;
  importance: number;
}

/**
 * Central memory service. Deliberately narrow: conversation history, semantic/preference
 * facts, and episodes. Each responsibility (scoring, extraction) is injected so it stays
 * replaceable, per the "no giant MemoryService" rule. Backed by MongoDB.
 */
export class MemoryService {
  constructor(
    private readonly scorer: IMemoryImportanceScorer = new DefaultImportanceScorer(),
    private readonly extractor: IMemoryExtractor = new LlmMemoryExtractor(),
  ) {}

  // ---- Conversation memory ----

  async addMessage(
    tenantId: string,
    userId: string,
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    const record: ConversationMessageRecord = {
      id: randomUUID(),
      tenantId,
      userId,
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    await conversationMessagesCollection().insertOne(record);
  }

  async getRecentMessages(sessionId: string, limit = CONVERSATION_WINDOW): Promise<ConversationMessageRecord[]> {
    const rows = await conversationMessagesCollection()
      .find({ sessionId }, NO_ID_PROJECTION)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return rows.reverse();
  }

  // ---- Semantic / preference memory ----

  /**
   * Stores a fact, resolving conflicts against any existing active fact with the same
   * subject+predicate: the old one is marked superseded (never deleted) and the new one
   * records provenance via `supersedes`.
   */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const existing = await memoriesCollection().findOne(
      {
        tenantId: input.tenantId,
        userId: input.userId,
        subject: input.subject,
        predicate: input.predicate,
        status: "active",
      },
      NO_ID_PROJECTION,
    );

    if (existing && existing.object === input.object) {
      // Same fact restated: reinforce importance/confidence rather than duplicating.
      const confidence = Math.max(existing.confidence, input.confidence);
      const importance = Math.max(existing.importance, input.importance);
      await memoriesCollection().updateOne({ id: existing.id }, { $set: { confidence, importance, updatedAt: now } });
      return { ...existing, confidence, importance, updatedAt: now };
    }

    if (existing && input.confidence >= existing.confidence) {
      // Conflict, and the new fact is at least as trustworthy: supersede, keep history.
      await memoriesCollection().updateOne({ id: existing.id }, { $set: { status: "superseded", validTo: now, updatedAt: now } });
    }

    const content = `${input.subject} ${input.predicate} ${input.object}`;
    const record: MemoryRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      type: input.type,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      content,
      source: input.source,
      confidence: input.confidence,
      importance: input.importance,
      status: !existing || input.confidence >= existing.confidence ? "active" : "superseded",
      supersedes: existing?.id ?? null,
      validFrom: now,
      validTo: null,
      createdAt: now,
      updatedAt: now,
      embedding: await embedText(content),
    };

    await memoriesCollection().insertOne(record);
    return record;
  }

  /**
   * Recalls facts relevant to `query`. Ranks by embedding cosine similarity when a query
   * embedding and at least one stored embedding are available; otherwise falls back to a
   * keyword regex scan over `content` so recall still works without an embedding provider.
   */
  async recall(tenantId: string, userId: string, query: string, limit = 5): Promise<MemoryRecord[]> {
    const queryEmbedding = await embedText(query);

    if (queryEmbedding) {
      const candidates = await memoriesCollection()
        .find({ tenantId, userId, status: "active", embedding: { $ne: null } }, NO_ID_PROJECTION)
        .toArray();

      if (candidates.length > 0) {
        return candidates
          .map((record) => ({ record, score: cosineSimilarity(queryEmbedding, record.embedding as number[]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((x) => x.record);
      }
    }

    return memoriesCollection()
      .find(
        {
          tenantId,
          userId,
          status: "active",
          content: { $regex: escapeRegExp(query), $options: "i" },
        },
        NO_ID_PROJECTION,
      )
      .sort({ importance: -1, confidence: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /** All active facts for a user, used to build compact context without a specific query. */
  async getActiveFacts(tenantId: string, userId: string, type?: MemoryType, limit = 20): Promise<MemoryRecord[]> {
    const filter: Record<string, unknown> = { tenantId, userId, status: "active" };
    if (type) filter.type = type;

    return memoriesCollection().find(filter, NO_ID_PROJECTION).sort({ importance: -1 }).limit(limit).toArray();
  }

  /** Full history (active + superseded) for a subject+predicate, oldest first. */
  async getTimeline(tenantId: string, userId: string, subject: string, predicate: string): Promise<MemoryRecord[]> {
    return memoriesCollection()
      .find({ tenantId, userId, subject, predicate }, NO_ID_PROJECTION)
      .sort({ validFrom: 1 })
      .toArray();
  }

  async forget(id: string): Promise<void> {
    await memoriesCollection().updateOne({ id }, { $set: { status: "deleted", updatedAt: new Date().toISOString() } });
  }

  // ---- Episodic / experience memory ----

  async recordEpisode(episode: Omit<EpisodeRecord, "id" | "createdAt" | "embedding">): Promise<void> {
    const record: EpisodeRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...episode,
      embedding: await embedText(episode.task),
    };
    await episodesCollection().insertOne(record);
  }

  /** Same embedding-with-keyword-fallback approach as recall() above. */
  async findSimilarEpisodes(tenantId: string, userId: string, task: string, limit = 3): Promise<EpisodeRecord[]> {
    const queryEmbedding = await embedText(task);

    if (queryEmbedding) {
      const candidates = await episodesCollection()
        .find({ tenantId, userId, embedding: { $ne: null } }, NO_ID_PROJECTION)
        .toArray();

      if (candidates.length > 0) {
        return candidates
          .map((record) => ({ record, score: cosineSimilarity(queryEmbedding, record.embedding as number[]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((x) => x.record);
      }
    }

    return episodesCollection()
      .find({ tenantId, userId, task: { $regex: escapeRegExp(task), $options: "i" } }, NO_ID_PROJECTION)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  // ---- Post-task extraction: classify a message and persist anything durable ----

  async extractAndPersist(tenantId: string, userId: string, message: string): Promise<MemoryRecord[]> {
    const facts = (await this.extractor.extract(message)).filter(
      (f): f is ExtractedFact & { memoryType: MemoryType } => f.memoryType !== "ignore",
    );
    const persisted: MemoryRecord[] = [];

    for (const fact of facts) {
      const importance = this.scorer.score(fact, { explicitStatement: true });
      if (importance < MIN_IMPORTANCE_TO_PERSIST) continue;

      persisted.push(
        await this.remember({
          tenantId,
          userId,
          type: fact.memoryType,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          source: "conversation",
          confidence: fact.confidence,
          importance,
        }),
      );
    }

    return persisted;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const memoryService = new MemoryService();
