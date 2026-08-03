const authView = document.getElementById("auth-view");
const chatView = document.getElementById("chat-view");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const whoami = document.getElementById("whoami");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let history = [];

function linkify(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/https?:\/\/\S+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = linkify(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function checkSession() {
  const res = await fetch("/auth/me");
  const data = await res.json();
  if (data.authenticated) {
    showChat(data.username);
  } else {
    showAuth();
  }
}

function showAuth() {
  authView.classList.remove("hidden");
  chatView.classList.add("hidden");
}

function showChat(username) {
  authView.classList.add("hidden");
  chatView.classList.remove("hidden");
  whoami.textContent = username;
}

async function submitAuth(action) {
  authError.textContent = "";
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    return;
  }

  const res = await fetch(`/auth/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    authError.textContent = data.error ?? "Something went wrong.";
    return;
  }

  const data = await res.json();
  history = [];
  messagesEl.innerHTML = "";
  showChat(data.username);
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth("login");
});

document.getElementById("signup-btn").addEventListener("click", () => submitAuth("signup"));

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  showAuth();
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  chatInput.value = "";
  appendMessage("user", text);
  history.push({ role: "user", content: text });

  const assistantEl = appendMessage("assistant", "");
  let assistantText = "";

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history }),
  });

  if (!res.ok || !res.body) {
    assistantEl.textContent = "Failed to reach the chat agent.";
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const payload = JSON.parse(line.slice("data: ".length));
      if (payload.delta) {
        assistantText += payload.delta;
        assistantEl.innerHTML = linkify(assistantText);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (payload.error) {
        assistantText += `\n[error] ${payload.error}`;
        assistantEl.innerHTML = linkify(assistantText);
      }
    }
  }

  history.push({ role: "assistant", content: assistantText });
});

checkSession();
