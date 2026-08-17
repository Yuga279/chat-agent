import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import { extractText } from "../agents/shared.js";

/** Pulls the canonical link URL out of a NOT_LINKED:: sentinel ToolMessage (see sharedTools.ts),
 * so the connect button always uses the real URL regardless of how the model paraphrased it. */
function extractNotLinkedUrl(newMessages: Array<AIMessage | ToolMessage>): string | null {
  for (const message of newMessages) {
    if (message.getType() !== "tool" || typeof message.content !== "string") continue;
    const match = message.content.match(/^NOT_LINKED::(\S+)::/);
    if (match) return match[1];
  }
  return null;
}

/** Deterministically appends a fixed-format connect link to the final assistant reply when a
 * not-linked tool result was seen this turn, so chat can reliably style/intercept it as a button
 * (web/src/style.css, ChatView.tsx) instead of depending on the model to relay the URL verbatim. */
export function appendNotLinkedButton(newMessages: Array<AIMessage | ToolMessage>): void {
  const linkUrl = extractNotLinkedUrl(newMessages);
  if (!linkUrl) return;

  const finalAi = [...newMessages].reverse().find((m): m is AIMessage => m.getType() === "ai");
  if (!finalAi) return;

  // A weak model can echo the raw URL itself despite being told not to, or a retried tool call
  // can otherwise cause this to run against text that already mentions the link - strip any
  // existing occurrence of the URL (bare, or already wrapped in the canonical markdown link)
  // before appending, so the button can never render twice.
  const escapedUrl = linkUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutExistingMentions = extractText(finalAi.content)
    .replace(new RegExp(`\\[[^\\]]*\\]\\(${escapedUrl}\\)`, "g"), "")
    .replace(new RegExp(escapedUrl, "g"), "")
    .trim();

  finalAi.content = `${withoutExistingMentions}\n\n[Connect your System1 account](${linkUrl})`;
}
