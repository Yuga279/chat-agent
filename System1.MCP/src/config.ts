function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  identityProviderUrl: requireEnv("SYSTEM1_IDP_URL"),
  apiBaseUrl: requireEnv("SYSTEM1_API_URL"),
  // Optional: only needed if the authenticated user belongs to more than one tenant.
  // Otherwise the single tenant is auto-resolved via GET /user/tenants after login.
  tenantId: process.env.SYSTEM1_TENANT_ID,
  clientId: requireEnv("SYSTEM1_MCP_CLIENT_ID"),
  clientSecret: requireEnv("SYSTEM1_MCP_CLIENT_SECRET"),
  // Public base URL this server is reachable at - must match the redirect URI
  // registered for this client in System1.IdentityProvider (Resources.cs).
  mcpServerUrl: requireEnv("SYSTEM1_MCP_SERVER_URL"),
  port: Number(process.env.PORT ?? 3100),
  // 32-byte key (base64) used to encrypt refresh tokens at rest. Generate with:
  // node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  tokenStoreEncryptionKey: requireEnv("SYSTEM1_TOKEN_STORE_KEY"),
  tokenStorePath: process.env.SYSTEM1_TOKEN_STORE_PATH ?? "./data/linked-accounts.db",
  // System1AppScope is the identity resource that carries the Role claim (Resources.cs:23) -
  // TenantGuardMiddleWare rejects requests whose token has no CARoleName/CURoleName role claim.
  scope: process.env.SYSTEM1_SCOPE ?? "openid profile System1ApiScope System1AppScope offline_access",
};
