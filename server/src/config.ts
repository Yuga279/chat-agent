function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  mcpServerUrl: requireEnv("MCP_SERVER_URL"),
  modelProvider: process.env.MODEL_PROVIDER ?? "openrouter",
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  modelName: process.env.MODEL_NAME ?? "anthropic/claude-sonnet-4.5",
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModelName: process.env.GEMINI_MODEL_NAME ?? "gemini-2.5-flash",
  jwtSecret: requireEnv("JWT_SECRET"),
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/",
  mongoDbName: process.env.MONGO_DB_NAME ?? "chat_agent",
  port: Number(process.env.PORT ?? 3200),

  // Memory v2 (see PLAN.md / CLAUDE.md's memory section). All default off/conservative so v1
  // behavior is unchanged until Atlas indexes + Gemini creds + `npm run memory:verify` pass.
  memoryV2Enabled: process.env.MEMORY_V2_ENABLED === "true",
  memoryCaptureEnabled: process.env.MEMORY_CAPTURE_ENABLED !== "false",
  memoryRetrievalEnabled: process.env.MEMORY_RETRIEVAL_ENABLED !== "false",
};

if (config.modelProvider === "gemini" && !config.geminiApiKey) {
  throw new Error("Missing required environment variable: GEMINI_API_KEY (MODEL_PROVIDER=gemini)");
}

if (config.modelProvider === "openrouter" && !config.openRouterApiKey) {
  throw new Error("Missing required environment variable: OPENROUTER_API_KEY (MODEL_PROVIDER=openrouter)");
}
