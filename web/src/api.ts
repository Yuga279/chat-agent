export interface Me {
  authenticated: boolean;
  id?: string;
  username?: string;
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch("/auth/me");
  return res.json();
}

export async function login(username: string, password: string): Promise<{ id: string; username: string }> {
  return authRequest("login", username, password);
}

export async function signup(username: string, password: string): Promise<{ id: string; username: string }> {
  return authRequest("signup", username, password);
}

async function authRequest(action: "login" | "signup", username: string, password: string) {
  const res = await fetch(`/auth/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "Something went wrong.");
  }
  return data;
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}

export interface ThreadRecord {
  threadId: string;
  createdAt: string;
  title?: string;
  workspaceId?: string | null;
}

export async function getThreads(): Promise<ThreadRecord[]> {
  const res = await fetch("/api/threads");
  const data = await res.json();
  return data.threads ?? [];
}

export async function createThread(options?: { workspaceId?: string | null; temporary?: boolean }): Promise<string> {
  const res = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ?? {}),
  });
  const data = await res.json();
  return data.threadId;
}

export async function renameThread(threadId: string, title: string): Promise<void> {
  await fetch(`/api/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

/** Moves a thread to a different workspace (or back to personal scope with workspaceId: null). */
export async function moveThreadToWorkspace(threadId: string, workspaceId: string | null): Promise<void> {
  await fetch(`/api/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
}

/** "End temporary chat": flips the thread back to normal so it starts showing up in the thread
 * list and its future turns start creating memory events again. */
export async function endTemporaryChat(threadId: string): Promise<void> {
  await fetch(`/api/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memoryMode: "normal" }),
  });
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: string;
}

export async function getWorkspaces(): Promise<WorkspaceRecord[]> {
  const res = await fetch("/api/workspaces");
  const data = await res.json();
  return data.workspaces ?? [];
}

export async function createWorkspace(name: string): Promise<WorkspaceRecord> {
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  return data.workspace;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await fetch(`/api/workspaces/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
}

export interface MemorySettings {
  enabled: boolean;
}

export async function getMemorySettings(): Promise<MemorySettings> {
  const res = await fetch("/api/memory/settings");
  return res.json();
}

export async function setMemorySettings(enabled: boolean): Promise<void> {
  await fetch("/api/memory/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export interface MemoryItem {
  id: string;
  scope: "user" | "workspace";
  workspaceId: string | null;
  kind: "preference" | "fact" | "episode";
  subject: string;
  predicate: string;
  object: string;
  content: string;
  importance: number;
  confidence: number;
  sourceEventIds: string[];
  updatedAt: string;
}

export async function getMemories(filter?: { scope?: "user" | "workspace"; workspaceId?: string }): Promise<MemoryItem[]> {
  const params = new URLSearchParams();
  if (filter?.scope) params.set("scope", filter.scope);
  if (filter?.workspaceId) params.set("workspaceId", filter.workspaceId);
  const res = await fetch(`/api/memories?${params.toString()}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function updateMemory(id: string, patch: Partial<Pick<MemoryItem, "subject" | "predicate" | "object" | "content">>): Promise<void> {
  await fetch(`/api/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteMemory(id: string): Promise<void> {
  await fetch(`/api/memories/${id}`, { method: "DELETE" });
}

export async function clearMemories(scope: "user" | "workspace", workspaceId?: string): Promise<void> {
  const params = new URLSearchParams({ scope });
  if (workspaceId) params.set("workspaceId", workspaceId);
  await fetch(`/api/memories?${params.toString()}`, { method: "DELETE" });
}

export async function deleteThread(threadId: string): Promise<void> {
  const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to delete thread");
  }
}

export interface System1Status {
  linked: boolean;
  linkUrl: string;
}

export async function getSystem1Status(): Promise<System1Status> {
  const res = await fetch("/api/system1/status");
  if (!res.ok) throw new Error("Failed to fetch System1 status");
  return res.json();
}

export async function disconnectSystem1(): Promise<void> {
  const res = await fetch("/api/system1/disconnect", { method: "POST" });
  if (!res.ok) throw new Error("Failed to disconnect System1 account");
}
