function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  mcpServerUrl: requireEnv("MCP_SERVER_URL"),
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  modelName: process.env.MODEL_NAME ?? "claude-sonnet-5",
  jwtSecret: requireEnv("JWT_SECRET"),
  dbPath: process.env.DB_PATH ?? "./data/chat-agent.db",
  port: Number(process.env.PORT ?? 3200),
};
