import { filter, map, Observable } from "rxjs";
import { LangGraphAgent, type ProcessedEvents } from "@ag-ui/langgraph";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { verifySessionToken } from "./auth.js";
import { claimOrVerifyThreadOwnership } from "./threadOwnership.js";

const SESSION_COOKIE = "session";
const LANGGRAPH_DEPLOYMENT_URL = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "http://localhost:2024";
const AGENT_GRAPH_IDS = ["assistant"] as const;

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      }),
  );
}

/**
 * Mirrors auth.ts's requireAuth, but for the raw fetch `Request` the CopilotKit v2 Express
 * bridge hands to agent factories - Express's cookie-parser middleware never runs on it.
 * Never trust anything the client sends about who it is; the externalUserId bound onto the
 * agent below always comes from this server-verified session, not from request body/props.
 */
async function resolveExternalUserId(request: Request): Promise<string | null> {
  const token = parseCookieHeader(request.headers.get("cookie"))[SESSION_COOKIE];
  return verifySessionToken(token);
}

/** Strips the underlying LangChain/LangGraph trace from every event before it reaches the
 * browser: `RAW` events carry the full trace verbatim (including this graph's system prompt
 * text), and most other AG-UI event types optionally carry the same trace on a `rawEvent`
 * field. Neither is chain-of-thought, but both leak prompt-engineering content to anyone
 * opening devtools, which the brief's "never expose internal reasoning" constraint covers. */
function sanitizeEvents(events$: Observable<ProcessedEvents>): Observable<ProcessedEvents> {
  return events$.pipe(
    filter((event) => event.type !== "RAW"),
    map((event) => {
      if (!("rawEvent" in event)) return event;
      const { rawEvent, ...rest } = event as BaseEvent & { rawEvent?: unknown };
      return rest as ProcessedEvents;
    }),
  );
}

/**
 * Security §18: a client-supplied threadId must not let one user read or continue another
 * user's conversation. LangGraph's dev/platform thread store isn't scoped per caller by
 * itself, so ownership is enforced here, at the one place every run for every agent passes
 * through, using `threadOwnership.ts`'s claim-on-first-use record.
 *
 * The CopilotKit runtime clones this agent per request/thread (`LangGraphAgent.clone()`), and
 * that override only re-copies fields it knows about - it drops any extra field a subclass adds
 * in its own constructor. So `externalUserId` is read from `assistantConfig.configurable`
 * instead of a constructor param: `assistantConfig` (and `config`) are two of the fields
 * `LangGraphAgent.clone()` *does* explicitly carry over, so this survives cloning where a
 * bespoke field would silently go missing (as it did - see git history/PR discussion).
 */
class OwnedLangGraphAgent extends LangGraphAgent {
  override run(input: RunAgentInput): Observable<ProcessedEvents> {
    const externalUserId = this.assistantConfig?.configurable?.externalUserId as string | undefined;
    return new Observable<ProcessedEvents>((subscriber) => {
      if (!externalUserId) {
        subscriber.error(new Error("Missing externalUserId on agent config."));
        return;
      }
      claimOrVerifyThreadOwnership(input.threadId, externalUserId).then((owned) => {
        if (!owned) {
          subscriber.error(new Error("This thread belongs to a different user."));
          return;
        }
        sanitizeEvents(super.run(input)).subscribe(subscriber);
      }, (error: unknown) => subscriber.error(error));
    });
  }
}

/**
 * AgentsFactory for CopilotKit's v2 runtime: resolves the caller's session on every request
 * and hands back one fresh OwnedLangGraphAgent per graph, all bound to that user via
 * `assistantConfig.configurable` (merged server-side into every run's config - see
 * researchGraph.ts/simpleAgentGraph.ts, which read `config.configurable.externalUserId`).
 * Keys must match langgraph.json's graph ids and the React app's agentId props.
 *
 * Deliberately does NOT throw when unauthenticated. This factory also backs the runtime's
 * `/info` endpoint (agent discovery/capabilities, no run access), which the client SDK probes
 * on connect to auto-detect transport - and treats anything but a 2xx as "not REST", falling
 * back to a single-route POST protocol this server doesn't register (`mode: "multi-route"`),
 * which then genuinely 404s. Throwing here for a missing/expired session turned that into a
 * permanent, confusing "agent_connect_failed: 404" instead of the real auth problem. Actual
 * agent execution still requires a valid externalUserId - enforced in OwnedLangGraphAgent.run()
 * below - so an unauthenticated caller can list agents but can never run one.
 */
export async function buildCopilotAgents({ request }: { request: Request }) {
  const externalUserId = await resolveExternalUserId(request);

  return Object.fromEntries(
    AGENT_GRAPH_IDS.map((graphId) => [
      graphId,
      new OwnedLangGraphAgent({
        deploymentUrl: LANGGRAPH_DEPLOYMENT_URL,
        graphId,
        assistantConfig: { configurable: { externalUserId } },
      }),
    ]),
  );
}
