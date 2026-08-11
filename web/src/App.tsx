import { useEffect, useState } from "react";
import { fetchMe } from "./api.js";
import AuthView from "./AuthView.js";
import ChatView from "./ChatView.js";

export default function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetchMe()
      .then((me) => setUsername(me.authenticated ? me.username ?? null : null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;

  return username ? (
    <ChatView username={username} onLoggedOut={() => setUsername(null)} />
  ) : (
    <AuthView onAuthenticated={setUsername} />
  );
}
