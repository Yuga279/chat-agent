import crypto from "node:crypto";
import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "./auth.js";
import {
  claimOrVerifyThreadOwnership,
  deleteThreadOwnership,
  ensureDefaultThreadId,
  listThreadsForUser,
  renameThread,
  setThreadMemoryMode,
  setThreadWorkspace,
} from "./threadOwnership.js";
import { DEFAULT_TENANT_ID } from "./constants.js";
import { memoryRepository } from "./memory/v2/repository.js";

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
    // Temporary threads are deliberately excluded from the thread list (PLAN.md's "Temporary
    // chat" requirement) - they're reached only via the in-progress chat itself, never resumed
    // from a list, and auto-expire on their own (see memoryWorker's TTL sweep).
    const visible = threads.filter((t) => t.memoryMode !== "temporary");
    // The frontend's Thread shape keys on `threadId`, not Mongo's `_id` - map here rather than
    // changing every web/src call site over a purely internal storage-key rename.
    res.json({
      threads: visible.map((t) => ({
        threadId: t._id,
        userId: t.userId,
        createdAt: t.createdAt,
        title: t.title,
        workspaceId: t.workspaceId,
      })),
    });
  });

  app.post("/api/threads", requireAuth, async (req: AuthedRequest, res) => {
    const threadId = crypto.randomUUID();
    await claimOrVerifyThreadOwnership(threadId, req.userId!);

    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : null;
    const temporary = req.body?.temporary === true;
    if (workspaceId) await setThreadWorkspace(threadId, req.userId!, workspaceId);
    if (temporary) await setThreadMemoryMode(threadId, req.userId!, "temporary");

    res.json({ threadId });
  });

  app.patch("/api/threads/:threadId", requireAuth, async (req: AuthedRequest, res) => {
    const { threadId } = req.params;
    const { title, workspaceId, memoryMode } = req.body ?? {};

    if (typeof title === "string" && title.trim()) {
      const renamed = await renameThread(threadId, req.userId!, title.trim().slice(0, 200));
      if (!renamed) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
    }

    // Moving a thread to a different workspace rescopes its future memory writes going forward -
    // existing items already written under the old scope are left alone (no retroactive
    // re-creation/removal pass here; PLAN.md's rescope job is a larger async migration this
    // synchronous PATCH deliberately does not attempt).
    if (workspaceId !== undefined) {
      const moved = await setThreadWorkspace(threadId, req.userId!, workspaceId === null ? null : String(workspaceId));
      if (!moved) {
        res.status(404).json({ error: "Thread not found" });
        return;
      }
    }

    if (memoryMode === "normal" || memoryMode === "temporary") {
      await setThreadMemoryMode(threadId, req.userId!, memoryMode);
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

    // Source-aware memory cleanup (PLAN.md Phase 4): removes this thread's own outstanding
    // memory_events (nothing further is ever leased for a deleted thread) and, for every item that
    // cited one of those events as a source, either strips just that source or deletes the item
    // once no source remains. Best-effort: the thread's own ownership record is already gone, so a
    // cleanup failure here must not stop the delete from succeeding.
    try {
      await memoryRepository.deleteEventsAndCleanupForThread(DEFAULT_TENANT_ID, req.userId!, threadId);
    } catch (error) {
      console.error(`Memory cleanup failed for deleted thread ${threadId} (thread delete still succeeds):`, error);
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
