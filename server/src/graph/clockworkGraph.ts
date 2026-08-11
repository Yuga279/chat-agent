import { CLOCKWORK_SYSTEM_PROMPT } from "../agent.js";
import { buildTools } from "../agents/sharedTools.js";
import { buildMemoryTools, composePreferenceContext } from "../memory/memoryTools.js";
import { DEFAULT_TENANT_ID } from "../constants.js";
import { buildSimpleAgentGraph } from "./simpleAgentGraph.js";

export const clockworkGraph = buildSimpleAgentGraph(
  async (externalUserId) => [...(await buildTools(externalUserId)), ...buildMemoryTools(DEFAULT_TENANT_ID, externalUserId)],
  async (externalUserId) => {
    const preferenceContext = await composePreferenceContext(DEFAULT_TENANT_ID, externalUserId);
    return preferenceContext ? `${CLOCKWORK_SYSTEM_PROMPT}\n\n${preferenceContext}` : CLOCKWORK_SYSTEM_PROMPT;
  },
);
