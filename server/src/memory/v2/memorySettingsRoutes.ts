import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "../../auth.js";
import { DEFAULT_TENANT_ID } from "../../constants.js";
import { isMemoryEnabledForUser, setMemoryEnabledForUser } from "./memorySettingsService.js";

/** GET/PUT /api/memory/settings - the global per-user on/off switch (PLAN.md Phase 4). Disabling
 * stops both reads and writes (see assistantGraph.ts's recordTurnMemory/resolveContext gating);
 * re-enabling never backfills what was skipped while paused. */
export function registerMemorySettingsRoutes(app: Express): void {
  app.get("/api/memory/settings", requireAuth, async (req: AuthedRequest, res) => {
    const enabled = await isMemoryEnabledForUser(DEFAULT_TENANT_ID, req.userId!);
    res.json({ enabled });
  });

  app.put("/api/memory/settings", requireAuth, async (req: AuthedRequest, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }
    await setMemoryEnabledForUser(DEFAULT_TENANT_ID, req.userId!, enabled);
    res.json({ ok: true });
  });
}
