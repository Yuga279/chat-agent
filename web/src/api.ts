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
