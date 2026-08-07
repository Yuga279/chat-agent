import crypto from "node:crypto";

interface PendingLink {
  externalUserId: string;
  codeVerifier: string;
  expiresAtMs: number;
}

const PENDING_LINK_TTL_MS = 5 * 60 * 1000;
const pendingLinks = new Map<string, PendingLink>();

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPendingLink(externalUserId: string): { state: string; codeVerifier: string; codeChallenge: string } {
  const state = base64UrlEncode(crypto.randomBytes(24));
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());

  pendingLinks.set(state, { externalUserId, codeVerifier, expiresAtMs: Date.now() + PENDING_LINK_TTL_MS });
  pruneExpired();

  return { state, codeVerifier, codeChallenge };
}

export function consumePendingLink(state: string): PendingLink | undefined {
  const pending = pendingLinks.get(state);
  if (!pending) {
    return undefined;
  }

  pendingLinks.delete(state);
  return pending.expiresAtMs > Date.now() ? pending : undefined;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [state, pending] of pendingLinks) {
    if (pending.expiresAtMs <= now) {
      pendingLinks.delete(state);
    }
  }
}
