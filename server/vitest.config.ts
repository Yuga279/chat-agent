import { defineConfig } from "vitest/config";

// Unit tests import modules that transitively reach config.ts (e.g. consolidator.ts -> its
// default repository singleton -> collections.ts -> db.ts -> config.ts), which throws at import
// time if required env vars are missing. These are dummy values - no real network/DB calls are
// made in the unit test suite (repository access is always injected via constructor/fakes).
export default defineConfig({
  test: {
    environment: "node",
    env: {
      MCP_SERVER_URL: "http://localhost:3100",
      JWT_SECRET: "test-secret",
      OPENROUTER_API_KEY: "test-key",
    },
  },
});
