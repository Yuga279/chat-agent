import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "../../auth.js";
import { DEFAULT_TENANT_ID } from "../../constants.js";
import type { MemoryItemScope } from "../types.js";
import { memoryRepository } from "./repository.js";

function parseScope(value: unknown): MemoryItemScope | undefined {
  return value === "user" || value === "workspace" ? value : undefined;
}

/** GET/PATCH/DELETE /api/memories - the Memory-management UI's backing API (PLAN.md Phase 4):
 * review, correct, delete, and clear-all, always scoped to the verified session's own userId -
 * never a client-supplied one. */
export function registerMemoriesRoutes(app: Express): void {
  app.get("/api/memories", requireAuth, async (req: AuthedRequest, res) => {
    const scope = parseScope(req.query.scope);
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
    const items = await memoryRepository.listItems(DEFAULT_TENANT_ID, req.userId!, {
      ...(scope ? { scope } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    });
    res.json({ items });
  });

  app.patch("/api/memories/:id", requireAuth, async (req: AuthedRequest, res) => {
    const { subject, predicate, object, content, importance } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof subject === "string") patch.subject = subject;
    if (typeof predicate === "string") patch.predicate = predicate;
    if (typeof object === "string") patch.object = object;
    if (typeof content === "string") patch.content = content;
    if (typeof importance === "number") patch.importance = importance;

    const updated = await memoryRepository.updateItemFields(DEFAULT_TENANT_ID, req.userId!, req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json({ item: updated });
  });

  app.delete("/api/memories/:id", requireAuth, async (req: AuthedRequest, res) => {
    const deleted = await memoryRepository.deleteOwnedItem(DEFAULT_TENANT_ID, req.userId!, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json({ ok: true });
  });

  // Clear-all: DELETE /api/memories?scope=user|workspace&workspaceId=...
  app.delete("/api/memories", requireAuth, async (req: AuthedRequest, res) => {
    const scope = parseScope(req.query.scope);
    if (!scope) {
      res.status(400).json({ error: "scope=user|workspace is required" });
      return;
    }
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
    const count = await memoryRepository.deleteItemsByScope(DEFAULT_TENANT_ID, req.userId!, scope, workspaceId);
    res.json({ ok: true, deletedCount: count });
  });
}
