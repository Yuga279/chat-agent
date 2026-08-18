import crypto from "node:crypto";
import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "./auth.js";
import {
  claimOrVerifyThreadOwnership,
  deleteThreadOwnership,
  ensureDefaultThreadId,
  listThreadsForUser,
  renameThread,
} from "./threadOwnership.js";

const LANGGRAPH_DEPLOYMENT_URL = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "http://localhost:2024";

export function registerThreadsRoute(app: Express): void {
  // Guarantees a non-empty list for a first-time user via ensureDefaultThreadId's atomic
  // insert-or-return-existing, rather than leaving "does this user need a default thread yet?"
  // to the client - that used to be decided client-side (create one if the list came back
  // empty), which raced under concurrent calls and left users with many auto-created threads.
  app.get("/api/threads", requireAuth, async (req: AuthedRequest, res) => {
    let threads = await listThreadsForUser(req.userId!);
    if (threads.length === 0) {
      await ensureDefaultThreadId(req.userId!);
      threads = await listThreadsForUser(req.userId!);
    }
    // The frontend's Thread shape keys on `threadId`, not Mongo's `_id` - map here rather than
    // changing every web/src call site over a purely internal storage-key rename.
    res.json({
      threads: threads.map((t) => ({ threadId: t._id, userId: t.userId, createdAt: t.createdAt, title: t.title })),
    });
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

  // Deletes a thread "from everywhere": our own ownership/default-pointer records in Mongo, and
  // the underlying LangGraph thread on :2024 (its checkpointed message history + any pending
  // interrupt) - without the second part the conversation would vanish from the UI but still
  // exist, reachable again if the same threadId ever got reused.
  app.delete("/api/threads/:threadId", requireAuth, async (req: AuthedRequest, res) => {
    const { threadId } = req.params;

    const deleted = await deleteThreadOwnership(threadId, req.userId!);
    if (!deleted) {
      res.status(404).json({ error: "Thread not found" });
      return;
    }

    try {
      const response = await fetch(`${LANGGRAPH_DEPLOYMENT_URL}/threads/${threadId}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        console.error(`Failed to delete LangGraph thread ${threadId}: ${response.status}`);
      }
    } catch (error) {
      // Best-effort: our own ownership record is already gone (the thread is unreachable to this
      // user regardless), so don't fail the request over the LangGraph dev server being down.
      console.error(`Failed to reach LangGraph deployment to delete thread ${threadId}:`, error);
    }

    res.json({ ok: true });
  });
}
