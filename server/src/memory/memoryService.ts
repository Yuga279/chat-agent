import { randomUUID } from "node:crypto";
import { conversationMessagesCollection, episodesCollection, semanticMemoriesCollection, toolExecutionsCollection } from "./collections.js";
import { DefaultImportanceScorer } from "./importanceScorer.js";
import { LlmMemoryExtractor } from "./classifier.js";
import { cosineSimilarity, embedText } from "./embeddings.js";
import type {
  ConversationMessageRecord,
  EpisodeRecord,
  ExtractedFact,
  IMemoryExtractor,
  IMemoryImportanceScorer,
  SemanticMemoryRecord,
  MemoryScope,
  MemorySource,
  MemoryType,
  ToolExecutionRecord,
} from "./types.js";

/** Tool argument keys never persisted verbatim - a small, hand-maintained allow-list of what's
 * NOT sensitive would be riskier (silently leaks a newly added field); redact-by-default and
 * explicitly allow only what's known safe. */
const SAFE_TOOL_ARG_KEYS = new Set(["query", "task", "projectId", "limit"]);

function redactToolArguments(args: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!args) return null;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    redacted[key] = SAFE_TOOL_ARG_KEYS.has(key) ? args[key] : "[redacted]";
  }
  return redacted;
}

const RESULT_SUMMARY_MAX_LENGTH = 500;

const CONVERSATION_WINDOW = 20;
const MIN_IMPORTANCE_TO_PERSIST = 0.5;
const NO_ID_PROJECTION = { projection: { _id: 0 } } as const;

export interface RememberInput {
  tenantId: string;
  userId: string;
  scope?: MemoryScope;
  type: MemoryType;
  subject: string;
  predicate: string;
  object: string;
  source: MemorySource;
  confidence: number;
  importance: number;
}

/**
 * Central memory service. Deliberately narrow: conversation history, semantic facts
 * (including user preferences), and episodes. Each responsibility (scoring, extraction) is
 * injected so it stays replaceable, per the "no giant MemoryService" rule. Backed by MongoDB.
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
    threadId: string | null,
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    const record: ConversationMessageRecord = {
      id: randomUUID(),
      tenantId,
      userId,
      threadId,
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

  // ---- Semantic memory ----

  /**
   * Stores a fact, resolving conflicts against any existing active fact with the same
   * subject+predicate: the old one is marked superseded (never deleted) and the new one
   * records provenance via `supersedes`.
   */
  async remember(input: RememberInput): Promise<SemanticMemoryRecord> {
    const now = new Date().toISOString();
    const existing = await semanticMemoriesCollection().findOne(
      {
        tenantId: input.tenantId,
        userId: input.userId,
        scope: input.scope ?? "user",
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
      await semanticMemoriesCollection().updateOne({ id: existing.id }, { $set: { confidence, importance, updatedAt: now } });
      return { ...existing, confidence, importance, updatedAt: now };
    }

    if (existing && input.confidence >= existing.confidence) {
      // Conflict, and the new fact is at least as trustworthy: supersede, keep history.
      await semanticMemoriesCollection().updateOne({ id: existing.id }, { $set: { status: "superseded", validTo: now, updatedAt: now } });
    }

    const content = `${input.subject} ${input.predicate} ${input.object}`;
    const record: SemanticMemoryRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      scope: input.scope ?? "user",
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

    await semanticMemoriesCollection().insertOne(record);
    return record;
  }

  /**
   * Recalls facts relevant to `query`. Ranks by embedding cosine similarity when a query
   * embedding and at least one stored embedding are available; otherwise falls back to a
   * keyword regex scan over `content` so recall still works without an embedding provider.
   */
  async recall(tenantId: string, userId: string, query: string, limit = 5): Promise<SemanticMemoryRecord[]> {
    const queryEmbedding = await embedText(query);

    // Retrieval filter applied before any similarity ranking: tenant-scoped, and either this
    // user's own memories or tenant-wide ones - never any other user's, and never client-supplied.
    const scopeFilter = {
      tenantId,
      status: "active" as const,
      $or: [{ scope: "user" as const, userId }, { scope: "tenant" as const }],
    };

    if (queryEmbedding) {
      const candidates = await semanticMemoriesCollection()
        .find({ ...scopeFilter, embedding: { $ne: null } }, NO_ID_PROJECTION)
        .toArray();

      if (candidates.length > 0) {
        return candidates
          .map((record) => ({ record, score: cosineSimilarity(queryEmbedding, record.embedding as number[]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((x) => x.record);
      }
    }

    return semanticMemoriesCollection()
      .find(
        { ...scopeFilter, content: { $regex: escapeRegExp(query), $options: "i" } },
        NO_ID_PROJECTION,
      )
      .sort({ importance: -1, confidence: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  /** All active facts for a user, used to build compact context without a specific query. */
  async getActiveFacts(tenantId: string, userId: string, type?: MemoryType, limit = 20): Promise<SemanticMemoryRecord[]> {
    const filter: Record<string, unknown> = {
      tenantId,
      status: "active",
      $or: [{ scope: "user", userId }, { scope: "tenant" }],
    };
    if (type) filter.type = type;

    return semanticMemoriesCollection().find(filter, NO_ID_PROJECTION).sort({ importance: -1 }).limit(limit).toArray();
  }

  /** Full history (active + superseded) for a subject+predicate, oldest first. */
  async getTimeline(tenantId: string, userId: string, subject: string, predicate: string): Promise<SemanticMemoryRecord[]> {
    return semanticMemoriesCollection()
      .find({ tenantId, userId, subject, predicate }, NO_ID_PROJECTION)
      .sort({ validFrom: 1 })
      .toArray();
  }

  async forget(id: string): Promise<void> {
    await semanticMemoriesCollection().updateOne({ id }, { $set: { status: "deleted", updatedAt: new Date().toISOString() } });
  }

  // ---- Episodic / experience memory ----

  async recordEpisode(episode: Omit<EpisodeRecord, "id" | "createdAt" | "embedding">): Promise<EpisodeRecord> {
    const record: EpisodeRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...episode,
      embedding: await embedText(episode.task),
    };
    await episodesCollection().insertOne(record);
    return record;
  }

  /** Detailed tool-call record, looked up by episodeId only when full arguments/results are
   * needed - episodes themselves only carry a lightweight ToolExecutionSummary. */
  async recordToolExecution(input: {
    tenantId: string;
    userId: string;
    threadId: string | null;
    sessionId: string | null;
    episodeId: string;
    toolName: string;
    arguments: Record<string, unknown> | undefined;
    result: unknown;
    status: "success" | "error";
    startedAt: string;
    completedAt: string;
  }): Promise<void> {
    const resultText = typeof input.result === "string" ? input.result : JSON.stringify(input.result ?? "");
    const record: ToolExecutionRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      userId: input.userId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      toolName: input.toolName,
      argumentsRedacted: redactToolArguments(input.arguments),
      resultSummary: resultText.slice(0, RESULT_SUMMARY_MAX_LENGTH),
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    };
    await toolExecutionsCollection().insertOne(record);
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

  async extractAndPersist(tenantId: string, userId: string, message: string): Promise<SemanticMemoryRecord[]> {
    const facts = (await this.extractor.extract(message)).filter(
      (f): f is ExtractedFact & { memoryType: MemoryType } => f.memoryType !== "ignore",
    );
    const persisted: SemanticMemoryRecord[] = [];

    for (const fact of facts) {
      const importance = this.scorer.score(fact);
      if (importance < MIN_IMPORTANCE_TO_PERSIST) continue;

      persisted.push(
        await this.remember({
          tenantId,
          userId,
          type: fact.memoryType,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          source: { type: "conversation", tenantId, userId, agent: "assistant" },
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
