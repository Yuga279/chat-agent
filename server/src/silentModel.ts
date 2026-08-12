import type { z } from "zod";
import { config } from "./config.js";

/**
 * Structured JSON completion via a raw HTTP call to the provider, deliberately bypassing
 * LangChain's ChatModel/Runnable classes entirely. LangGraph's message-streaming (what turns
 * model output into AG-UI TEXT_MESSAGE_* events) hooks into LangChain's callback system - a
 * Runnable invocation, even one tagged "langsmith:nostream", was still observed leaking its raw
 * JSON into the chat stream in this stack. A plain fetch() has no callback/Runnable involvement
 * at all, so there is nothing for that streaming machinery to capture. Use this only for
 * internal, non-conversational decisions (e.g. planning) that must never appear as chat output.
 */
export async function silentJsonCompletion<T>(systemPrompt: string, userPrompt: string, schema: z.ZodType<T>): Promise<T> {
  const raw = config.modelProvider === "gemini" ? await callGemini(systemPrompt, userPrompt) : await callOpenRouter(systemPrompt, userPrompt);
  return schema.parse(JSON.parse(raw));
}

async function callOpenRouter(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter silent completion failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  const content = body.choices[0]?.message.content;
  if (!content) throw new Error("OpenRouter silent completion returned no content.");
  return content;
}

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModelName}:generateContent?key=${config.geminiApiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 500 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini silent completion failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const content = body.candidates[0]?.content.parts[0]?.text;
  if (!content) throw new Error("Gemini silent completion returned no content.");
  return content;
}
