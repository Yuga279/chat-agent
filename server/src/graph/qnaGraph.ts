import { QNA_SYSTEM_PROMPT } from "../agents/qnaAgent.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { DEFAULT_TENANT_ID } from "../constants.js";
import { buildSimpleAgentGraph } from "./simpleAgentGraph.js";

export const qnaGraph = buildSimpleAgentGraph(
  async (externalUserId) => buildMemoryTools(DEFAULT_TENANT_ID, externalUserId),
  async (externalUserId) => {
    const preferenceContext = await composePreferenceContext(DEFAULT_TENANT_ID, externalUserId);
    return preferenceContext ? `${QNA_SYSTEM_PROMPT}\n\n${preferenceContext}` : QNA_SYSTEM_PROMPT;
  },
);
