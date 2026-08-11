import { useState, type FormEvent } from "react";
import { login, signup } from "./api.js";

export default function AuthView({ onAuthenticated }: { onAuthenticated: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(action: "login" | "signup") {
    setError("");
    if (!username.trim() || !password) return;
    try {
      const data = action === "login" ? await login(username.trim(), password) : await signup(username.trim(), password);
      onAuthenticated(data.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    handleSubmit("login");
  }

  return (
    <div className="view">
      <form className="auth-form" onSubmit={handleFormSubmit}>
        <h1>System1 Chat</h1>
        <input
          type="text"
          placeholder="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="auth-actions">
          <button type="submit">Log in</button>
          <button type="button" onClick={() => handleSubmit("signup")}>
            Sign up
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
