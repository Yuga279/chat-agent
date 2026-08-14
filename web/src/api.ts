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
}

export async function getThreads(): Promise<ThreadRecord[]> {
  const res = await fetch("/api/threads");
  const data = await res.json();
  return data.threads ?? [];
}

export async function createThread(): Promise<string> {
  const res = await fetch("/api/threads", { method: "POST" });
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
