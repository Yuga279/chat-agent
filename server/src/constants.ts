/** Single-tenant today; kept as an explicit constant so multi-tenant support is a config change, not a rewrite. */
export const DEFAULT_TENANT_ID = "default";

export const AGENT_NAMES = ["clockwork", "research", "qna"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
