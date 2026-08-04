function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  mcpServerUrl: requireEnv("MCP_SERVER_URL"),
  openRouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  modelName: process.env.MODEL_NAME ?? "anthropic/claude-sonnet-4.5",
  jwtSecret: requireEnv("JWT_SECRET"),
  dbPath: process.env.DB_PATH ?? "./data/chat-agent.db",
  port: Number(process.env.PORT ?? 3200),
};
