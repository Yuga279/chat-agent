import type { Express, Request, Response } from "express";
import { config } from "./config.js";
import { createPendingLink, consumePendingLink } from "./pkce.js";
import { clearAccessTokenCache, exchangeAuthorizationCode } from "./tokenClient.js";
import { isLinked, saveRefreshToken, unlink } from "./tokenStore.js";

export function registerOAuthRoutes(app: Express): void {
  app.get("/oauth/link", (req: Request, res: Response) => {
    // Trim stray trailing punctuation (e.g. a ")" pulled in by a client that mangled a
    // markdown-rendered link) so a mis-rendered link can't silently link the wrong id.
    const rawExternalUserId = typeof req.query.externalUserId === "string" ? req.query.externalUserId : undefined;
    const externalUserId = rawExternalUserId?.replace(/[).,;:!?]+$/, "");
    if (!externalUserId) {
      res.status(400).send("Missing required query parameter: externalUserId");
      return;
    }

    const { state, codeChallenge } = createPendingLink(externalUserId);

    const authorizeUrl = new URL("/connect/authorize", config.identityProviderUrl);
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", config.scope);
    authorizeUrl.searchParams.set("redirect_uri", `${config.mcpServerUrl}/oauth/callback`);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    res.redirect(authorizeUrl.toString());
  });

  app.get("/oauth/status", (req: Request, res: Response) => {
    const rawExternalUserId = typeof req.query.externalUserId === "string" ? req.query.externalUserId : undefined;
    const externalUserId = rawExternalUserId?.replace(/[).,;:!?]+$/, "");
    if (!externalUserId) {
      res.status(400).json({ error: "Missing required query parameter: externalUserId" });
      return;
    }

    res.status(200).json({ externalUserId, linked: isLinked(externalUserId) });
  });

  app.post("/oauth/unlink", (req: Request, res: Response) => {
    // Query param, not a JSON body, matching the other routes here - no body-parsing middleware
    // is assumed to be mounted on this Express app.
    const rawExternalUserId = typeof req.query.externalUserId === "string" ? req.query.externalUserId : undefined;
    const externalUserId = rawExternalUserId?.replace(/[).,;:!?]+$/, "");
    if (!externalUserId) {
      res.status(400).json({ error: "Missing required query parameter: externalUserId" });
      return;
    }

    unlink(externalUserId);
    clearAccessTokenCache(externalUserId);
    res.status(200).json({ externalUserId, linked: false });
  });

  app.get("/oauth/callback", async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;

    if (!code || !state) {
      res.status(400).send("Missing required query parameters: code, state");
      return;
    }

    const pending = consumePendingLink(state);
    if (!pending) {
      res.status(400).send("This link request has expired or was already used. Please try linking again.");
      return;
    }

    try {
      const token = await exchangeAuthorizationCode(code, pending.codeVerifier);
      if (!token.refresh_token) {
        res.status(500).send("System1 did not issue a refresh token - check that offline_access scope is granted.");
        return;
      }

      saveRefreshToken(pending.externalUserId, token.refresh_token);
      res.status(200).send("System1 account linked successfully. You can return to the chat now.");
    } catch (error) {
      console.error("Failed to complete account link:", error);
      res.status(500).send("Failed to link your System1 account. Please try again.");
    }
  });
}
