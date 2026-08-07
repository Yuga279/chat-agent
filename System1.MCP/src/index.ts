import "dotenv/config";
import { Agent, setGlobalDispatcher } from "undici";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Request, Response } from "express";
import { deleteEntries, endEntry, getActiveEntryForToday, getEntriesByDate, startEntry } from "./clockWorkClient.js";
import { NotLinkedError } from "./tokenClient.js";
import { config } from "./config.js";
import { registerOAuthRoutes } from "./oauthRoutes.js";

const EXTERNAL_USER_ID_HEADER = "x-external-user-id";

const startEntrySchema = z.object({
  projectId: z.string().optional().describe("Guid of the project to log time against; omit to use the caller's default task/project"),
  taskId: z.string().optional().describe("Guid of the task to log time against; omit to use the caller's default task/project"),
  description: z.string().optional().describe("Optional entry description"),
  startTime: z.string().optional().describe("ISO 8601 start time; defaults to now"),
});

const endEntrySchema = z.object({
  entryId: z
    .string()
    .optional()
    .describe("Guid of the running entry to end; if omitted, ends the caller's current running entry"),
});

const deleteEntriesSchema = z.object({
  entryIds: z.array(z.string()).min(1).describe("Guids of the ClockWork entries to delete"),
});

const getEntriesSchema = z.object({
  date: z
    .string()
    .optional()
    .describe("Date to fetch entries for, as yyyy-MM-dd; omit to use today's date"),
});

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function notLinkedResult(externalUserId: string) {
  return textResult({
    isOk: false,
    error: "not_linked",
    message: `No System1 account is linked for this user yet. Direct them to link one, then retry.`,
    linkUrl: `${config.mcpServerUrl}/oauth/link?externalUserId=${encodeURIComponent(externalUserId)}`,
  });
}

/** Builds a fresh MCP server bound to a single request's caller identity (stateless per call). */
function buildServer(externalUserId: string): Server {
  const server = new Server({ name: "system1-clockwork", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "clockwork_start_entry",
        description:
          "Start a new ClockWork time entry for the authenticated user. projectId/taskId are optional - " +
          "if omitted, the entry falls back to the caller's default task preference, or is created unlinked.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            taskId: { type: "string" },
            description: { type: "string" },
            startTime: { type: "string" },
          },
        },
      },
      {
        name: "clockwork_end_entry",
        description:
          "End a running ClockWork time entry. If entryId is omitted, ends the caller's currently running entry.",
        inputSchema: {
          type: "object",
          properties: {
            entryId: { type: "string" },
          },
        },
      },
      {
        name: "clockwork_delete_entries",
        description: "Delete one or more ClockWork entries by id.",
        inputSchema: {
          type: "object",
          properties: {
            entryIds: { type: "array", items: { type: "string" } },
          },
          required: ["entryIds"],
        },
      },
      {
        name: "clockwork_get_entries",
        description:
          "Get all ClockWork time entries for the authenticated user on a given date. " +
          "date is optional (yyyy-MM-dd) - if omitted, returns today's entries.",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "clockwork_start_entry": {
          const params = startEntrySchema.parse(args);
          const response = await startEntry(externalUserId, params);
          return textResult(response);
        }

        case "clockwork_end_entry": {
          const params = endEntrySchema.parse(args);
          let entryId = params.entryId;
          if (!entryId) {
            const active = await getActiveEntryForToday(externalUserId);
            entryId = active?.id;
            if (!entryId) {
              throw new Error("No running entry found to end for the current user.");
            }
          }

          const response = await endEntry(externalUserId, { entryId });
          return textResult(response);
        }

        case "clockwork_delete_entries": {
          const params = deleteEntriesSchema.parse(args);
          const response = await deleteEntries(externalUserId, params.entryIds);
          return textResult(response);
        }

        case "clockwork_get_entries": {
          const params = getEntriesSchema.parse(args);
          const entries = await getEntriesByDate(externalUserId, params.date);
          return textResult({ isOk: true, entries });
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof NotLinkedError) {
        return notLinkedResult(externalUserId);
      }
      throw error;
    }
  });

  return server;
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const externalUserId = req.header(EXTERNAL_USER_ID_HEADER);
  if (!externalUserId) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Missing required "${EXTERNAL_USER_ID_HEADER}" header.` },
      id: null,
    });
    return;
  }

  const server = buildServer(externalUserId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function main() {
  if (process.env.SYSTEM1_INSECURE_TLS === "1") {
    // Local IDP/API dev certs are self-signed; undici's fetch doesn't honor
    // NODE_TLS_REJECT_UNAUTHORIZED on its own, so set the dispatcher explicitly.
    setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
  }

  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: undefined });

  registerOAuthRoutes(app);

  app.post("/mcp", (req, res) => {
    handleMcpRequest(req, res).catch((error) => {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    });
  });

  app.listen(config.port, () => {
    console.log(`System1 MCP server listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error("System1 MCP server failed to start:", error);
  process.exit(1);
});
