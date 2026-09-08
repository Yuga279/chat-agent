import { LangfuseSpanProcessor } from "@langfuse/otel";
import { CallbackHandler } from "@langfuse/langchain";
import { startActiveObservation, propagateAttributes } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

export const langfuseEnabled = Boolean(publicKey && secretKey);

function maskSensitiveData({ data }: { data: unknown }): unknown {
  if (typeof data === "string") {
    return data.replace(/(authorization|api[-_]?key|password|secret|token)=([^\s,}]+)/gi, "$1=[REDACTED]");
  }
  if (Array.isArray(data)) return data.map((value) => maskSensitiveData({ data: value }));
  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) =>
        /(authorization|api[-_]?key|password|secret|token)/i.test(key)
          ? [key, "[REDACTED]"]
          : [key, maskSensitiveData({ data: value })],
      ),
    );
  }
  return data;
}

export const langfuseSpanProcessor = langfuseEnabled
  ? new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      release: process.env.LANGFUSE_RELEASE,
      mask: maskSensitiveData,
    })
  : undefined;

if (langfuseSpanProcessor) {
  new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] }).register();
}

export function createLangfuseHandler(userId: string, sessionId: string | null): CallbackHandler | undefined {
  if (!langfuseEnabled) return undefined;
  return new CallbackHandler({
    userId,
    sessionId: sessionId ?? undefined,
    tags: ["chat", "assistant"],
    traceMetadata: { feature: "assistant", environment: process.env.NODE_ENV ?? "development" },
  });
}

export async function withLangfuseTurn<T>(
  userId: string,
  sessionId: string | null,
  input: string,
  operation: (handler: CallbackHandler | undefined) => Promise<T>,
): Promise<T> {
  if (!langfuseEnabled) return operation(undefined);

  return startActiveObservation("assistant-turn", async (span) => {
    span.update({ input });
    return propagateAttributes({ traceName: "assistant-turn", userId, sessionId: sessionId ?? undefined }, async () => {
      const result = await operation(createLangfuseHandler(userId, sessionId));
      span.update({ output: "completed" });
      return result;
    });
  });
}