import crypto from "node:crypto";
import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { claimOrVerifyThreadOwnership, listThreadsForUser, renameThread } from "./threadOwnership.js";

export function registerThreadsRoute(app: Express): void {
  app.get("/api/threads", requireAuth, async (req: AuthedRequest, res) => {
    const threads = await listThreadsForUser(req.userId!);
    res.json({ threads });
  });

  app.post("/api/threads", requireAuth, async (req: AuthedRequest, res) => {
    const threadId = crypto.randomUUID();
    await claimOrVerifyThreadOwnership(threadId, req.userId!);
    res.json({ threadId });
  });

  app.patch("/api/threads/:threadId", requireAuth, async (req: AuthedRequest, res) => {
    const { threadId } = req.params;
    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : "";
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const renamed = await renameThread(threadId, req.userId!, title);
    if (!renamed) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }
    res.json({ ok: true });
  });
}
