import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "../../auth.js";
import { DEFAULT_TENANT_ID } from "../../constants.js";
import type { MemoryItemScope } from "../types.js";
import { memoryRepository } from "./repository.js";

function parseScope(value: unknown): MemoryItemScope | undefined {
  return value === "user" || value === "workspace" ? value : undefined;
}

/** Clamps a client-supplied importance value to [0, 1], the range every other part of the
 * pipeline (ranking, profile-card sorting) assumes it's already in. Returns null for anything that
 * isn't a finite number at all (NaN, Infinity, a string) - the caller treats that as "don't touch
 * this field" rather than silently writing 0. Previously this field passed straight through with
 * no validation, and it's the single heaviest term in retrieval ranking and the profile card's
 * sort key - one PATCH with an unbounded value could permanently pin an item to the top of both. */
function clampImportance(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

function parseLimit(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(n));
}

function parseCursor(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** GET/PATCH/DELETE /api/memories - the Memory-management UI's backing API (PLAN.md Phase 4):
 * review, correct, delete, and clear-all, always scoped to the verified session's own userId -
 * never a client-supplied one. */
export function registerMemoriesRoutes(app: Express): void {
  app.get("/api/memories", requireAuth, async (req: AuthedRequest, res) => {
    const scope = parseScope(req.query.scope);
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
    const limit = parseLimit(req.query.limit);
    const before = parseCursor(req.query.before);

    const { items, hasMore } = await memoryRepository.listItems(
      DEFAULT_TENANT_ID,
      req.userId!,
      { ...(scope ? { scope } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}) },
      { limit, before },
    );
    const nextCursor = hasMore ? items[items.length - 1]?.updatedAt.toISOString() : null;
    res.json({ items, nextCursor });
  });

  app.patch("/api/memories/:id", requireAuth, async (req: AuthedRequest, res) => {
    const { subject, predicate, object, content, importance } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof subject === "string") patch.subject = subject;
    if (typeof predicate === "string") patch.predicate = predicate;
    if (typeof object === "string") patch.object = object;
    if (typeof content === "string") patch.content = content;
    if (importance !== undefined) {
      const clamped = clampImportance(importance);
      if (clamped === undefined) {
        res.status(400).json({ error: "importance must be a finite number" });
        return;
      }
      patch.importance = clamped;
    }

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
