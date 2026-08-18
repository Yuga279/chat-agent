import { config } from "../config.js";

// "text-embedding-004" (the original model here) 404s against the current API - Gemini's
// embedding models get deprecated/renamed over time the same way dated chat model ids do (see
// CLAUDE.md's note on gemini-flash-lite-latest vs pinned dated ids). Confirmed working 2026-08-13
// via `GET /v1beta/models?key=...` filtered to supportedGenerationMethods including embedContent.
const EMBEDDING_MODEL = "gemini-embedding-001";

// Logged once, not per-call - embedText() runs on every remember()/recall()/recordEpisode(), so a
// missing key would otherwise spam the log on every single memory operation.
let warnedMissingKey = false;

/**
 * Embeds text via Gemini's embedContent endpoint - always Gemini, independent of MODEL_PROVIDER,
 * since OpenRouter has no equivalent embeddings endpoint this app can rely on today. Returns null
 * (never throws) when no GEMINI_API_KEY is configured or the call fails, so callers can fall back
 * to keyword search instead of breaking recall entirely - but every fallback path now logs loudly
 * rather than degrading silently, since a silent null here previously looked identical to "no key
 * configured" even when a real bug (e.g. a deprecated model id) was the actual cause.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!config.geminiApiKey) {
    if (!warnedMissingKey) {
      console.warn(
        "embedText: GEMINI_API_KEY is not set - semantic memory/episode recall will fall back to " +
          "plain substring matching for the rest of this process. Set GEMINI_API_KEY to enable it " +
          "(required regardless of MODEL_PROVIDER).",
      );
      warnedMissingKey = true;
    }
    return null;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      },
    );

    if (!response.ok) {
      console.error(
        `embedText: request to Gemini embedContent (model "${EMBEDDING_MODEL}") failed with ` +
          `${response.status} - falling back to substring matching for this call. If this persists, ` +
          `the model id may be deprecated; check GET /v1beta/models?key=... for a current replacement.`,
        await response.text(),
      );
      return null;
    }

    const body = (await response.json()) as { embedding?: { values: number[] } };
    if (!body.embedding?.values) {
      console.error("embedText: Gemini embedContent returned no embedding values - falling back to substring matching.");
      return null;
    }
    return body.embedding.values;
  } catch (error) {
    console.error("embedText: request threw - falling back to substring matching for this call.", error);
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
