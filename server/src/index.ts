import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import type { AIMessageChunk } from "@langchain/core/messages";
import { config } from "./config.js";
import { registerAuthRoutes, requireAuth, type AuthedRequest } from "./auth.js";
import { runAgent } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "../../web");

function extractText(content: AIMessageChunk["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is { type: "text"; text: string } => "type" in part && part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(webDir));

  registerAuthRoutes(app);

  app.post("/api/chat", requireAuth, async (req: AuthedRequest, res) => {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const stream = await runAgent(req.userId!, messages);
      for await (const [chunk] of stream) {
        if (chunk.getType() !== "ai") {
          continue;
        }

        const text = extractText(chunk.content);
        if (text) {
          res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (error) {
      console.error("Agent run failed:", error);
      res.write(`data: ${JSON.stringify({ error: "Something went wrong processing your message." })}\n\n`);
    } finally {
      res.end();
    }
  });

  app.listen(config.port, () => {
    console.log(`System1 chat agent listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error("Chat agent server failed to start:", error);
  process.exit(1);
});
