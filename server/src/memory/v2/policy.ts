/**
 * Deterministic (non-LLM) sensitivity gate applied to every extraction candidate before it can be
 * auto-captured. Per PLAN.md: financial identifiers, government IDs, health/political/religious/
 * identity data, and uncertain sensitive candidates must never be captured automatically - only
 * through the explicit remember_fact + memory_consent approval path (see assistantGraph.ts's
 * pendingMemoryConsent wiring, Phase 3).
 *
 * Deliberately regex/keyword-based, not model-based: the extractor's own LLM call already
 * produced the candidate, so a second LLM call to classify it would just be another chance for
 * the same model to be wrong in the same way. A simple deterministic net over well-known
 * identifier shapes and topic keywords is easier to audit and cheaper to run on every candidate.
 */

const FINANCIAL_ID_PATTERNS = [
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // card-number-shaped
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped
  /\biban\b/i,
  /\brouting number\b/i,
  /\bcvv\b/i,
];

const GOV_ID_KEYWORDS = [
  "passport number",
  "driver's license",
  "drivers license",
  "national id",
  "aadhaar",
  "social security number",
];

const SENSITIVE_TOPIC_KEYWORDS = [
  // health
  "diagnosis",
  "medication",
  "hiv",
  "mental health",
  "therapy",
  "disability",
  "pregnan",
  // political
  "political party",
  "voted for",
  // religious
  "religion",
  "religious",
  // identity
  "sexual orientation",
  "gender identity",
  "immigration status",
  "citizenship status",
];

export type SensitivityLevel = "none" | "sensitive";

export interface PolicyCandidate {
  subject: string;
  predicate: string;
  object: string;
  content: string;
}

export class MemoryPolicy {
  /** Classifies a single extraction candidate. Never throws - an unexpected shape is treated as
   * sensitive (fail closed) rather than silently auto-captured. */
  classify(candidate: PolicyCandidate): SensitivityLevel {
    try {
      const text = `${candidate.subject} ${candidate.predicate} ${candidate.object} ${candidate.content}`.toLowerCase();

      if (FINANCIAL_ID_PATTERNS.some((p) => p.test(text))) return "sensitive";
      if (GOV_ID_KEYWORDS.some((k) => text.includes(k))) return "sensitive";
      if (SENSITIVE_TOPIC_KEYWORDS.some((k) => text.includes(k))) return "sensitive";

      return "none";
    } catch {
      return "sensitive";
    }
  }

  /** Whether a candidate at this sensitivity level may be written automatically without explicit
   * user consent - only non-sensitive, reasonably-confident candidates qualify. */
  canAutoCapture(sensitivity: SensitivityLevel, confidence: number): boolean {
    return sensitivity === "none" && confidence >= 0.6;
  }
}

export const memoryPolicy = new MemoryPolicy();
