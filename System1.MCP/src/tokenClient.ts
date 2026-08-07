import { config } from "./config.js";
import { getRefreshToken, saveRefreshToken } from "./tokenStore.js";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class NotLinkedError extends Error {
  constructor(public readonly externalUserId: string) {
    super(`No System1 account linked for user "${externalUserId}". Link one via /oauth/link.`);
    this.name = "NotLinkedError";
  }
}

const accessTokenCache = new Map<string, CachedToken>();

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${config.identityProviderUrl}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
}

/** Exchanges an authorization code for tokens as part of the one-time account-link flow. */
export async function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: `${config.mcpServerUrl}/oauth/callback`,
    }),
  );
}

async function fetchTokenWithRefreshToken(refreshToken: string): Promise<TokenResponse> {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  );
}

/** Returns a valid bearer token for the given chat user, refreshing as needed. */
export async function getAccessToken(externalUserId: string): Promise<string> {
  const cached = accessTokenCache.get(externalUserId);
  const nowMs = Date.now();
  if (cached && nowMs < cached.expiresAtMs) {
    return cached.accessToken;
  }

  const refreshToken = getRefreshToken(externalUserId);
  if (!refreshToken) {
    throw new NotLinkedError(externalUserId);
  }

  const token = await fetchTokenWithRefreshToken(refreshToken);

  if (token.refresh_token) {
    saveRefreshToken(externalUserId, token.refresh_token);
  }

  // Refresh 30s before actual expiry to avoid races with in-flight calls.
  const expiresAtMs = nowMs + Math.max(token.expires_in - 30, 0) * 1000;
  accessTokenCache.set(externalUserId, { accessToken: token.access_token, expiresAtMs });

  return token.access_token;
}
