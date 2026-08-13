import { config } from "../config.js";

// "text-embedding-004" (the original model here) 404s against the current API - Gemini's
// embedding models get deprecated/renamed over time the same way dated chat model ids do (see
// CLAUDE.md's note on gemini-flash-lite-latest vs pinned dated ids). Confirmed working 2026-08-13
// via `GET /v1beta/models?key=...` filtered to supportedGenerationMethods including embedContent.
const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Embeds text via Gemini's embedContent endpoint. Returns null (never throws) when no
 * GEMINI_API_KEY is configured or the call fails, so callers can fall back to keyword search
 * instead of breaking recall entirely.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!config.geminiApiKey) return null;

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
      console.error("embedText request failed:", response.status, await response.text());
      return null;
    }

    const body = (await response.json()) as { embedding?: { values: number[] } };
    return body.embedding?.values ?? null;
  } catch (error) {
    console.error("embedText threw:", error);
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
