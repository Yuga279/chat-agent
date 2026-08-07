import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { config } from "./config.js";

export function createModel(maxTokens: number) {
  return config.modelProvider === "gemini"
    ? new ChatGoogleGenerativeAI({
        apiKey: config.geminiApiKey,
        model: config.geminiModelName,
        maxOutputTokens: maxTokens,
      })
    : new ChatOpenAI({
        apiKey: config.openRouterApiKey,
        model: config.modelName,
        maxTokens,
        configuration: { baseURL: "https://openrouter.ai/api/v1" },
      });
}

export const model = createModel(500);
