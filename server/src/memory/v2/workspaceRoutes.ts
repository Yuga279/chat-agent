import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "../../auth.js";
import { DEFAULT_TENANT_ID } from "../../constants.js";
import { unassignWorkspaceFromThreads } from "../../threadOwnership.js";
import { memoryRepository } from "./repository.js";
import { workspaceService } from "./workspaceService.js";

/** GET/POST/PATCH/DELETE /api/workspaces - user-owned chat workspaces (PLAN.md Phase 4). Deleting
 * a workspace purges only its workspace-scoped memories/summaries and unassigns its threads; the
 * threads/chats themselves are never deleted here. */
export function registerWorkspaceRoutes(app: Express): void {
  app.get("/api/workspaces", requireAuth, async (req: AuthedRequest, res) => {
    const workspaces = await workspaceService.list(DEFAULT_TENANT_ID, req.userId!);
    res.json({ workspaces });
  });

  app.post("/api/workspaces", requireAuth, async (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 200) : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const workspace = await workspaceService.create(DEFAULT_TENANT_ID, req.userId!, name);
    res.json({ workspace });
  });

  app.patch("/api/workspaces/:id", requireAuth, async (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 200) : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const renamed = await workspaceService.rename(DEFAULT_TENANT_ID, req.userId!, req.params.id, name);
    if (!renamed) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.delete("/api/workspaces/:id", requireAuth, async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const owned = await workspaceService.getOwned(DEFAULT_TENANT_ID, req.userId!, id);
    if (!owned) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    await memoryRepository.purgeWorkspace(DEFAULT_TENANT_ID, id);
    await unassignWorkspaceFromThreads(id, DEFAULT_TENANT_ID);
    await workspaceService.delete(DEFAULT_TENANT_ID, req.userId!, id);

    res.json({ ok: true });
  });
}
