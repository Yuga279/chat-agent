import { config } from "./config.js";
import { getAccessToken } from "./tokenClient.js";

interface TenantDto {
  id: string;
  name: string;
}

interface TenantsResponse {
  tenants: TenantDto[];
}

const cachedTenantIdByUser = new Map<string, string>();

/**
 * Resolves the tenantId to scope all ClockWork calls under, for the given chat user.
 * Mirrors the SPA's post-login TenantGateway flow (GET user/tenants), since the API
 * has no tenant context until an authenticated user's tenant memberships are looked up.
 */
export async function resolveTenantId(externalUserId: string): Promise<string> {
  const cached = cachedTenantIdByUser.get(externalUserId);
  if (cached) {
    return cached;
  }

  if (config.tenantId) {
    cachedTenantIdByUser.set(externalUserId, config.tenantId);
    return config.tenantId;
  }

  const token = await getAccessToken(externalUserId);
  const response = await fetch(`${config.apiBaseUrl}/api/v1/user/tenants`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to resolve tenant (${response.status}): ${text}`);
  }

  const body = (await response.json()) as TenantsResponse;
  const tenants = body.tenants ?? [];

  if (tenants.length === 0) {
    throw new Error("Authenticated user has no tenant memberships.");
  }

  if (tenants.length > 1) {
    const options = tenants.map((t) => `${t.name} (${t.id})`).join(", ");
    throw new Error(
      `User belongs to multiple tenants: ${options}. Set SYSTEM1_TENANT_ID in the MCP server env to disambiguate.`,
    );
  }

  cachedTenantIdByUser.set(externalUserId, tenants[0].id);
  return tenants[0].id;
}
