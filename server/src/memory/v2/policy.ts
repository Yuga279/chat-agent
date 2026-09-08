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

/**
 * Credentials/secrets - refused outright (see canAutoCapture and, for the explicit tool path,
 * memoryTools.ts), never merely consent-gated the way "sensitive" content is. There is no
 * legitimate reason for the agent to persist a live credential, so unlike a health/political fact
 * a user might deliberately choose to remember, a secret is never offered a consent prompt at all.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style API key
  /\bsk-ant-[A-Za-z0-9-]{16,}\b/, // Anthropic-style API key
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub personal access token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/, // PEM private key block
  /\b\w{2,10}:\/\/[^\s:/@]+:[^\s@]+@[^\s]+/, // connection string with embedded credentials
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{12,}/i,
];

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

/** "secret" is strictly worse than "sensitive": a health fact can be remembered with consent, a
 * live API key never should be, regardless of consent - see canAutoCapture and memoryTools.ts. */
export type SensitivityLevel = "none" | "sensitive" | "secret";

export interface PolicyCandidate {
  subject: string;
  predicate: string;
  object: string;
  content: string;
}

export class MemoryPolicy {
  /** Classifies a single extraction candidate. Never throws - an unexpected shape is treated as
   * sensitive (fail closed) rather than silently auto-captured. Checked against the *original-case*
   * text for secret patterns (many are case-sensitive token shapes, e.g. an API key prefix), and
   * against the lowercased text for keyword matching. */
  classify(candidate: PolicyCandidate): SensitivityLevel {
    try {
      const rawText = `${candidate.subject} ${candidate.predicate} ${candidate.object} ${candidate.content}`;
      if (SECRET_PATTERNS.some((p) => p.test(rawText))) return "secret";

      const text = rawText.toLowerCase();
      if (FINANCIAL_ID_PATTERNS.some((p) => p.test(text))) return "sensitive";
      if (GOV_ID_KEYWORDS.some((k) => text.includes(k))) return "sensitive";
      if (SENSITIVE_TOPIC_KEYWORDS.some((k) => text.includes(k))) return "sensitive";

      return "none";
    } catch {
      return "sensitive";
    }
  }

  /** Whether a candidate at this sensitivity level may be written automatically without explicit
   * user consent - only non-sensitive, reasonably-confident candidates qualify. A "secret" can
   * never auto-capture regardless of confidence, same as "sensitive" - the distinction matters at
   * the call site (memoryTools.ts refuses a secret outright; a merely-sensitive candidate still
   * gets a consent prompt), not here. */
  canAutoCapture(sensitivity: SensitivityLevel, confidence: number): boolean {
    return sensitivity === "none" && confidence >= 0.6;
  }
}

export const memoryPolicy = new MemoryPolicy();
