import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";

const EXTERNAL_USER_ID_HEADER = "X-External-User-Id";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface NotLinkedToolResult {
  isOk: false;
  error: "not_linked";
  message: string;
  linkUrl: string;
}

async function withClient<T>(externalUserId: string | undefined, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(`${config.mcpServerUrl}/mcp`), {
    requestInit: externalUserId ? { headers: { [EXTERNAL_USER_ID_HEADER]: externalUserId } } : undefined,
  });
  const client = new Client({ name: "system1-chat-agent", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

let cachedTools: McpTool[] | undefined;

/** Tool list is user-independent, so any placeholder header value is fine here. */
export async function listMcpTools(): Promise<McpTool[]> {
  if (cachedTools) {
    return cachedTools;
  }

  const result = await withClient("tool-discovery", (client) =>
    client.request({ method: "tools/list" }, ListToolsResultSchema),
  );

  cachedTools = result.tools as McpTool[];
  return cachedTools;
}

export function isNotLinkedResult(payload: unknown): payload is NotLinkedToolResult {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { error?: unknown }).error === "not_linked" &&
    typeof (payload as { linkUrl?: unknown }).linkUrl === "string"
  );
}

/** Calls an MCP tool as the given chat user; the MCP server resolves their linked System1 identity. */
export async function callMcpTool(externalUserId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  console.log(`[mcp] calling tool "${name}" with args:`, JSON.stringify(args));
  const result = await withClient(externalUserId, (client) =>
    client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema),
  );

  const textContent = result.content.find((item): item is { type: "text"; text: string } => item.type === "text");
  if (!textContent) {
    throw new Error(`Tool "${name}" returned no text content.`);
  }

  const parsed = JSON.parse(textContent.text);
  console.log(`[mcp] tool "${name}" result:`, JSON.stringify(parsed));
  return parsed;
}
