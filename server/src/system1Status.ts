import type { Express, Response } from "express";
import { config } from "./config.js";
import { requireAuth, type AuthedRequest } from "./auth.js";

/**
 * Reports whether the current user's System1 account is linked, and gives the frontend a
 * ready-to-open link URL - built server-side so the browser never needs to know the MCP
 * server's address or construct the externalUserId query param itself.
 */
export function registerSystem1StatusRoute(app: Express): void {
  app.get("/api/system1/status", requireAuth, async (req: AuthedRequest, res: Response) => {
    const externalUserId = req.userId!;

    try {
      const statusUrl = new URL("/oauth/status", config.mcpServerUrl);
      statusUrl.searchParams.set("externalUserId", externalUserId);
      const mcpRes = await fetch(statusUrl.toString());
      const body = (await mcpRes.json()) as { linked?: boolean };

      const linkUrl = new URL("/oauth/link", config.mcpServerUrl);
      linkUrl.searchParams.set("externalUserId", externalUserId);

      res.json({ linked: Boolean(body.linked), linkUrl: linkUrl.toString() });
    } catch (error) {
      console.error("Failed to check System1 link status:", error);
      res.status(502).json({ error: "Could not reach System1 MCP server" });
    }
  });

  app.post("/api/system1/disconnect", requireAuth, async (req: AuthedRequest, res: Response) => {
    const externalUserId = req.userId!;

    try {
      const unlinkUrl = new URL("/oauth/unlink", config.mcpServerUrl);
      unlinkUrl.searchParams.set("externalUserId", externalUserId);
      const mcpRes = await fetch(unlinkUrl.toString(), { method: "POST" });
      if (!mcpRes.ok) {
        res.status(502).json({ error: "Could not disconnect System1 account" });
        return;
      }

      res.json({ linked: false });
    } catch (error) {
      console.error("Failed to disconnect System1 account:", error);
      res.status(502).json({ error: "Could not reach System1 MCP server" });
    }
  });
}
