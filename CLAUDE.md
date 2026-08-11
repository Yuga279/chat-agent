# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

- `server/` — the chat agent backend (Express + LangGraph + MongoDB). This is where almost all work happens.
- `web/` — a React + TypeScript + Vite frontend (login/signup, an agent-switcher tab bar, and a CopilotKit chat UI). Built with `npm run build` into `web/dist/`, which `server/`'s Express app serves as static files in production; `npm run dev` runs a hot-reload Vite server on `:5173` that proxies `/auth` and `/api` to `:3200` during development.
- `System1.MCP/` — a **separate, sibling** project: an MCP server (Express + `@modelcontextprotocol/sdk`, backed by `better-sqlite3`) that exposes System1 ClockWork time-tracking tools (start/stop/delete entry, list projects/tasks). `server/` is purely an MCP *client* of it, talking over HTTP; the URL is configured via `MCP_SERVER_URL`. Treat it as out-of-repo unless a task explicitly touches it — it has its own `package.json`/`tsconfig.json`/build.

## Two parallel chat surfaces — know which one you're touching

There are **two independent ways the three agents (clockwork/research/qna) get run**, coexisting in the same codebase:

1. **Legacy REST/SSE path** (`POST /api/chat`, `src/index.ts`) — the original implementation: `createAgent()`-based agents (`src/agent.ts`, `src/agents/researchAgent.ts`, `src/agents/qnaAgent.ts`), the hand-rolled `goalService`/`planner.ts`/`approval.ts` multi-step-goal/HITL machinery, conversation memory, episodes, extraction. Nothing in the current `web/` UI calls this anymore, but it's fully functional and untouched — hit it directly with `curl -X POST /api/chat` if you need it.
2. **AG-UI/CopilotKit/LangGraph path** (`POST /api/copilotkit/*`, `src/copilotRuntime.ts`) — what the React app actually talks to. Each of the three agents is *also* implemented as a real LangGraph `StateGraph` (`src/graph/*.ts`), hosted by a **separate `langgraph dev` process** (see below), reached via `@ag-ui/langgraph`'s `LangGraphAgent`. This is where plan review, human-in-the-loop approval, and interactive questions live (research only) — the legacy path's `goalService` proposal/approval flow has no equivalent here and isn't used by this path.

These two paths **duplicate the underlying agent logic** (same system prompts, same tool lists, same `buildTools()`/`buildMemoryTools()`/`composePreferenceContext()` calls) but via structurally different execution shapes (`createAgent()`'s internal ReAct loop vs. explicit graph nodes). When editing a system prompt or tool list, check whether the change needs to land in *both* the `src/agent*.ts` file and its `src/graph/*.ts` counterpart (see "Keeping the two implementations in sync" below).

## Commands (run from `server/` unless noted)

- `npm run build` — compile TypeScript to `dist/` (`tsc -p tsconfig.json`)
- `npm run dev` — compile in watch mode (does not restart the server itself, just recompiles)
- `npm start` — run the compiled server: `node --env-file=.env dist/index.js`. Requires a `.env` file — copy `.env.example` and fill in `JWT_SECRET`, `OPENROUTER_API_KEY` (or `GEMINI_API_KEY` if `MODEL_PROVIDER=gemini`), and point `MCP_SERVER_URL` at a running `System1.MCP` instance.
- `npm run graph:dev` — starts `langgraphjs dev --port 2024`, hosting the `research`/`clockwork`/`qna` graphs (`server/langgraph.json`) for local development. **Must be running** for the AG-UI/CopilotKit path (`/api/copilotkit/*`) to work at all — `npm start` alone is not enough; see "Why two server processes" below.
- `node --env-file=.env dist/scripts/verifyAgUiStream.js <externalUserId> "<question>"` (after `npm run build`; also `npm run verify:agui -- <externalUserId> "<question>"`) — a standalone smoke test that runs the `research` graph directly through `@ag-ui/langgraph`'s `LangGraphAgent`, bypassing Express/CopilotKit entirely. Useful for isolating "is the graph itself broken" from "is the runtime/routing broken."
- From `web/`: `npm run dev` (Vite dev server, `:5173`, proxies `/auth` and `/api` to `:3200`), `npm run build` (`tsc --noEmit && vite build`, outputs to `web/dist/`, which is what `server/`'s Express app serves in production).
- No test suite, linter, or formatter is configured anywhere in this repo. Don't assume `npm test`/`npm run lint` exist.
- There is no `nodemon`/live-reload wired up for `dist/index.js` — after editing `.ts` you need a fresh `npm run build` (or a running `npm run dev` watch) *and* a server restart to see changes when running via `npm start`. The same applies to `npm run graph:dev` — it re-reads compiled/transpiled graph modules at its own startup, so a code change under `src/graph/` needs that process restarted too, independently of the main server.

## Why two server processes (`:3200` and `:2024`)

`@ag-ui/langgraph`'s `LangGraphAgent` is a **client** of the LangGraph Platform API (thread creation/state/streaming-run endpoints) via `deploymentUrl` — it does not run a compiled graph in-process. `langgraphjs dev` is what implements that API locally. So `copilotRuntime.ts` (running inside the `:3200` Express process) makes HTTP calls to `localhost:2024` (or `LANGGRAPH_DEPLOYMENT_URL` if set) exactly the way it calls the MCP server on `:3100` — this is a structural consequence of the library's integration model, not a merge-able convenience split. It's also what gives every thread its persistence (messages, plan, current step, pending interrupt) for free — `research`'s plan-review/HITL/resume behavior all rely on state the `:2024` process is keeping, not anything `:3200` stores itself.

`web/`'s Vite dev server (`:5173`) is unrelated to this and *is* just a convenience: production serves `web/dist/` directly from Express (`:3200`), no separate frontend process at all.

## Runtime dependencies

- **MongoDB** — required at startup (`connectDb()` in `src/db.ts`, now idempotent — safe to call from multiple entry points; throws if it can't connect on the *first* call); stores users, conversation history, memories, episodes, goals, and `thread_owners` (see Security below). Default `mongodb://localhost:27017/`, db name `chat_agent`. **Both** the `:3200` Express process and the `:2024` `langgraphjs dev` process end up connecting to it independently — the graph modules under `src/graph/` call `connectDb()`/`ensureMemoryIndexes()` themselves on first use (`ensureReady()`/`ensureGraphReady()` in `researchGraph.ts`/`simpleAgentGraph.ts`) since they have no shared startup path with `index.ts` when hosted standalone by `langgraphjs dev`.
- **System1.MCP server** — required for the `clockwork` and `research` agents' tool calls to work (both call `buildTools()`, on *either* execution path); `qna` never needs it. `listMcpTools()` is called once at first use and cached, so if the MCP server isn't up yet when a request first triggers it, that failure isn't retried per-request — a restart is needed after bringing MCP up.
  - Account linking uses OAuth+PKCE against System1's IdP (`System1.MCP/src/oauthRoutes.ts`, `tokenClient.ts`), storing an encrypted refresh token per `externalUserId` in SQLite (`tokenStore.ts`). `getAccessToken()` in `tokenClient.ts` refreshes the access token transparently on every call; if the IdP rejects the refresh token itself (401, or 400 `invalid_grant` — i.e. it's expired/revoked, not a transient network failure), the stored refresh token is deleted (`unlink()`) and a `NotLinkedError` is thrown so the caller gets the normal re-link flow instead of a generic failure with a permanently-dead token left in the store.
- **OpenRouter or Gemini** — the chat model provider. Selected via `MODEL_PROVIDER` env var (`"openrouter"` default, or `"gemini"`). `config.ts` throws at startup if the corresponding API key is missing.
  - Free-tier model slugs on both providers are unreliable in practice: OpenRouter's `:free` model list changes over time (query `GET https://openrouter.ai/api/v1/models` with your key to see what's actually still offered) and is capped at ~50 requests/day with zero account credit (429 `openrouter_free_tier_daily` once exhausted — add credits or wait for the daily reset). Gemini's free tier is model-specific and can be as low as 5 requests/minute (`gemini-2.5-flash`); `gemini-flash-lite-latest` has a much higher free quota and is a safer default than pinning an exact dated model name, since dated Gemini model ids get deprecated (404) over time. Since a single chat turn can fire several LLM calls (routing, planning, memory classification, main agent — and on the graph path, also plan generation and clarification checks), an aggressively-limited free model exhausts its quota almost immediately.
  - **Gemini-specific gotcha**: Gemini rejects any request whose final message is a model/assistant turn ("Requests ending with a model turn are not supported"). `researchGraph.ts`'s `synthesizeNode` hit this in practice — the step loop's last message is always an AI turn, so the synthesis instruction has to be appended as a trailing `HumanMessage`, not folded into the system prompt. Keep this in mind before adding any new direct `model.invoke(messages, config)` call on a message list that might end in an AI message.

## Architecture: legacy REST/SSE path

### Request flow (`src/index.ts`)

`POST /api/chat`, behind `requireAuth`, is the entry point. Per request:

1. **Body**: `{ messages: Array<{role: "user"|"assistant", content: string}>, agent?: "clockwork"|"research"|"qna" }`. `messages` is the full running transcript from the client (not just the new message) — the client is expected to resend history each turn; server-side conversation memory (see below) is a separate, independent log, not what's replayed into the LLM context on subsequent turns.
2. **Agent selection** (`AGENT_RUNNERS` map — `clockwork` → `runAgent`, `research` → `runResearchAgent`, `qna` → `runQnaAgent`), in priority order:
   - Explicit `agent` field in the request body always wins and **skips goal tracking entirely** (no goal is read, created, or advanced on this turn).
   - Otherwise, if there's a proposed goal awaiting approval (see Goals below), the turn is consumed interpreting the user's reply as approve/reject/unclear.
   - Otherwise, if the user has an active `GoalRecord` with a pending current step, that step's `agent` is used, and the step's `description` is appended to the outgoing user message as `(Current step to work on: ...)` so the agent knows what it's meant to accomplish right now — the raw latest user message is *not* what drives agent choice in this branch.
   - Otherwise, `planGoal()` is tried first (may turn a single message into a whole multi-step goal proposal); if it declines, `routeToAgent()` makes a single-agent routing choice.
3. **Streaming response**: sets SSE headers (`Content-Type: text/event-stream`, no caching, keep-alive) and writes newline-delimited `data: {...}\n\n` JSON events in this order:
   - `{ agent, step }` — emitted immediately, before any model output, so the client can show which agent/step is active. Both are `null` when the turn is a goal-approval exchange handled without running any specialist agent (see Goals below).
   - `{ delta }` — one per streamed AI-message chunk of text (non-`"ai"`-typed chunks, e.g. tool-call chunks, are filtered out entirely; nothing is sent to the client about tool calls in progress).
   - `{ goalProgress: { title, status, doneSteps, totalSteps, nextStep } }` — only when this turn was driven by an active goal; emitted **after** the agent finishes and the goal is advanced via `goalService.advanceCurrentStep()`.
   - `{ error }` — only on a caught exception from the agent run; the raw error is logged server-side (`console.error`) but never leaked to the client.
   - `{ done: true }` — always the final event, in both success and error paths (`finally` calls `res.end()`).
4. `extractText()` pulls plain text out of an `AIMessageChunk`'s `content`, which may be a string or an array of content parts — only `{type: "text"}` parts are concatenated; this same helper is duplicated in `src/agents/shared.ts` (used by the agents themselves) — keep both in sync if the message-content shape assumptions ever change.

### Three specialist agents (legacy path)

All three are built with `createAgent()` from the top-level `langchain` package (migrated off the deprecated `createReactAgent` from `@langchain/langgraph/prebuilt` — the param is `model`, not `llm`) and follow an identical shape: build a tool list, load preference context, prepend a system prompt, stream via `.stream(state, {streamMode: "messages"})`, tee the stream through `wrapWithConversationMemory`. The differences are entirely in system prompt and tool set:

- **clockwork** (`src/agent.ts`, prompt exported as `CLOCKWORK_SYSTEM_PROMPT`) — tools: MCP tools (`buildTools`) + memory tools. System prompt is written to act immediately on requests using only the arguments the user gave (never asks the user to fill in optional tool args — omit and let tool defaults apply; only asks a clarifying question for a *missing required* argument), and to never leak raw tool JSON/IDs/GUIDs to the user — replies are 1–2 plain sentences, no headers/bullets/bold for simple confirmations. Session ID for conversation memory is just `externalUserId` (shared with no other agent). This is the **default** agent when routing is ambiguous.
- **research** (`src/agents/researchAgent.ts`, prompt exported as `RESEARCH_SYSTEM_PROMPT`) — tools: MCP tools + memory tools (same as clockwork). System prompt instructs it to check memory (`recall_memory`, `get_similar_experiences`) *before* using data tools, reuse a working prior approach when one exists, cite what it found, call `remember_fact` only for durable cross-task facts (not one-off findings), and be explicit about uncertainty rather than fabricating. Session ID is `${externalUserId}:research` (a separate conversation log from clockwork/qna). Unlike the other two, it passes an `episode` to `wrapWithConversationMemory`, so every research run also gets recorded as an `EpisodeRecord` for future `get_similar_experiences` lookups.
- **qna** (`src/agents/qnaAgent.ts`, prompt exported as `QNA_SYSTEM_PROMPT`) — tools: memory tools **only**, no MCP tools — it cannot take any real action. System prompt tells it to check `recall_memory` before answering and, if asked to do something requiring action, to say so and point the user at the ClockWork assistant instead of attempting it. Session ID is `${externalUserId}:qna`.

Both prompts are exported specifically so `src/graph/*.ts` (the AG-UI path) can reuse them verbatim rather than duplicating the text — see "Keeping the two implementations in sync" below.

Shared plumbing lives in two files:
- `src/agents/shared.ts` — re-exports `DEFAULT_TENANT_ID`, `extractText()`, and `wrapWithConversationMemory()`: an async-generator wrapper that passes every stream chunk through untouched (so the caller/SSE loop sees no difference) while accumulating the assistant's full text and the set of tool names called, then *after the stream ends*, persists the assistant's final text to conversation memory and — only if an `episode` option was passed — records an `EpisodeRecord` (outcome truncated to 500 chars, `success: true` unconditionally — there's no failure-path episode recording currently, so `findSimilarEpisodes` results are optimistic by construction).
- `src/agents/sharedTools.ts` — `buildTools(externalUserId)` calls `listMcpTools()` (cached, user-independent) and wraps each MCP tool description as a LangChain `tool()`, binding `externalUserId` via closure so every call is scoped to that chat user. A non-linked-account result from the MCP call is turned into a plain-English tool return value pointing the user at a link URL, rather than throwing — the agent treats it as a normal tool result to relay, not an error. Used by **both** execution paths.

### Routing vs. planning (`src/router.ts`, `src/planner.ts`)

Both use small, cheap, separate LLM instances (`createModel(maxTokens)` from `src/llm.ts` — 300 tokens for planning, 100 for routing) with `.withStructuredOutput(zodSchema)`, distinct from the main chat `model` export (500 tokens). Keep that separation when touching either file — don't reuse the shared `model` here.

- **`planGoal(message)`** (`src/planner.ts`) — asks whether the message needs decomposition into 2–5 sequential steps across agents (`isMultiStep`, `title`, `steps: [{description, agent}]`). Returns `null` (not a goal) whenever `isMultiStep` is false *or* fewer than 2 steps come back, even if the model said `isMultiStep: true` — that inconsistency is treated as "not actually multi-step." On any LLM error, logs and returns `null` (falls through to routing), so planning failures never block a response. The prompt also encourages decomposing a single broad **research** request into multiple ordered `research`-tagged steps (not just cross-agent plans), so open-ended research gets more approval touchpoints via the gate below.
- **`routeToAgent(message)`** (`src/router.ts`) — one-shot classification into `clockwork | research | qna`. Defaults to `"clockwork"` both on an ambiguous/short-follow-up message (per its own prompt instructions) and on any LLM error (in the `catch`) — so `clockwork` is the system's overall fallback agent in every failure mode.
- Both are called from `index.ts` **only** when there's no proposed/active goal and no explicit `agent` override.

### Goals (`src/memory/goalService.ts`)

`GoalRecord`s (`goals` collection) represent a persistent, multi-step objective spanning turns/sessions. Each `GoalStep` has `{description, agent, status: "pending"|"done"}`. A goal's own `status` is `"proposed" | "active" | "done" | "abandoned"`.

- **Human-in-the-loop approval gate**: `planGoal()`'s decomposition is never executed immediately. `index.ts` calls `goalService.proposeGoal()`, which inserts the goal with `status: "proposed"` and immediately returns a formatted plan (`formatPlanPrompt()` — title + numbered `[agent] description` list + "Shall I go ahead? (yes/no)") as the turn's entire response — no specialist agent runs on this turn, no tool calls happen, and `goalId`/`agentName` in that SSE `{agent, step}` event are both `null`.
- On the *next* turn, `index.ts` checks `goalService.getProposedGoal()` **before** `getActiveGoal()`. If a proposed goal is pending, that turn is entirely consumed interpreting the reply via `classifyApproval()` (`src/approval.ts`, a `createModel(60)` structured classifier, same pattern as `router.ts`) — it never falls through to routing or an active-goal step in this branch:
  - `"approve"` → `goalService.approveGoal()` flips status to `"active"`; the turn then runs step 0 exactly like resuming an active goal.
  - `"reject"` → `goalService.abandonGoal()`; the turn responds with a canned cancellation message, no agent run.
  - `"unclear"` → the goal stays `"proposed"`; the turn re-sends the same plan prompt rather than guessing which way to interpret an ambiguous reply.
- This gate only applies when there's no explicit `agent` override on the request.
- `getActiveGoal()` returns the most recently *created* active goal (sorted `createdAt: -1`) — if a user somehow has more than one active goal, index.ts always resumes the newest, and the others are invisible to the main chat flow (though still visible via the `get_active_goals` tool's `listActiveGoals`, which lists up to 5 and only lists `status: "active"`).
- `advanceCurrentStep(goalId)` marks the current step `"done"` and increments `currentStepIndex`; the goal's own `status` flips to `"done"` once the index runs past the last step. There's no step-level failure state — a step can only be `"pending"` or `"done"`, so a failed tool call inside a goal step still gets marked done on the next `advanceCurrentStep()` call.
- `abandonGoal()` is reachable from the rejection path above, but there's still no way to cancel an already-**active** (approved) goal mid-flight.
- **This entire mechanism is specific to the legacy REST path.** The AG-UI/CopilotKit path's plan review/HITL (see below) is a structurally different, LangGraph-`interrupt()`-based system with no shared code or state with `goalService`.

### Auth (`src/auth.ts`, `src/db.ts`)

Cookie-based JWT sessions, no refresh-token flow — a single 7-day-TTL JWT (`jwt.sign({sub: userId}, ..., {expiresIn: SESSION_TTL_SECONDS})`) stored in an `httpOnly`, `sameSite: "lax"` cookie named `session`. `requireAuth` re-validates the user still exists in Mongo on every request (not just JWT signature/expiry) via `findUserById`, so a deleted user is deauthenticated immediately even with a still-valid token. Passwords are bcrypt-hashed (cost factor 10) in `createUser`; there's no password-reset or email-verification flow. `/auth/me` never 401s — it always returns 200 with `{authenticated: boolean, ...}`, distinct from every other route which 401s via `requireAuth`. **Both execution paths share this same cookie/session** — `copilotRuntime.ts` re-implements the cookie-parsing + JWT-verify logic itself (see below) since it operates on a raw fetch `Request`, not an Express `req` with `cookie-parser` middleware already run.

## Architecture: AG-UI/CopilotKit/LangGraph path

### The graphs (`src/graph/`)

- **`simpleAgentGraph.ts`** — `buildSimpleAgentGraph(getTools, getSystemPrompt)` factory: a single-node LangGraph `StateGraph` (`MessagesAnnotation`) that reimplements the same model-call/tool-execution ReAct loop `createAgent()` does internally, explicitly, so it can be exported as a graph. Both `getTools`/`getSystemPrompt` are resolved from `config.configurable.externalUserId` on every invocation, not closed over at graph-build time — there is **one compiled graph shared across every user's threads**, so nothing user-specific can be baked in at construction. Also exports `ensureGraphReady()`, the standalone-host DB-connection bootstrap shared by clockwork/qna's graphs.
- **`clockworkGraph.ts`** / **`qnaGraph.ts`** — thin instantiations of `buildSimpleAgentGraph`, reusing `CLOCKWORK_SYSTEM_PROMPT`/`QNA_SYSTEM_PROMPT` and the same tool-building calls as their `src/agent*.ts` counterparts.
- **`researchGraph.ts`** — the interesting one; a multi-node graph implementing plan review, step-by-step execution with live progress, an approval gate before synthesis, and agent-initiated clarifying questions. Its own `ensureReady()`/DB-bootstrap pattern mirrors `simpleAgentGraph.ts`'s (duplicated rather than shared, since this graph predates that factory).

`researchGraph.ts`'s node/edge shape:

```
START --routeFromStart-->
  "planner"     (no plan yet on this thread)
  "followUp"    (thread already has a finalAnswer - plain tool-using chat turn, no plan/step machinery)
  "startStep"   (fallback: a fresh run arrived mid-flow, shouldn't normally happen - see below)

planner -> planReview [interrupt: plan_edit] --routeAfterPlanReview-->
  "startStep"   (approved/updated)
  END           (rejected - finalAnswer set to a cancellation message)

startStep --routeAfterStartStep-->
  "clarifyStep" (a pending step was found and marked "running")
  "synthesisApproval" (no pending steps left)

clarifyStep [maybe interrupt: question] -> runStep -> (loop back to startStep)

synthesisApproval [interrupt: approval] --routeAfterSynthesisApproval-->
  "synthesize"  (approved)
  END           (rejected - finalAnswer set to a cancellation message)

synthesize -> END
followUp -> END
```

- **`plannerNode`** — structured-output LLM call (2-8 steps, `{title, description?}`), builds a `ResearchPlan` (`planTypes.ts`: `{version, steps: [{id, title, description?, status, order}]}`, ids via `randomUUID()`, all `status: "pending"`). On any error, falls back to `{version: 1, steps: []}` rather than failing the run.
- **`planReviewNode`** — the plan-editing/HITL checkpoint (spec's Phase 4+5, and where §7's generic interaction model shows up for the first time): calls LangGraph's `interrupt()` with an `AgentInteraction` (`interactionTypes.ts`) of `{type: "plan_edit", id, plan}`. Resume value shape: `{action: "approve"} | {action: "update", plan: ResearchPlan} | {action: "reject"}`. An `"update"` bumps `plan.version`. If `state.plan` came back empty from the planner, this node is a no-op (nothing to review).
- **`startStepNode`** — picks `plan.steps.find(s => s.status === "pending")` and flips it to `"running"`, **no LLM call** — deliberately a separate, fast node from `runStepNode` so the client sees the "running" status tick *before* the slow part starts (an AG-UI `STATE_SNAPSHOT` fires after every node completes).
- **`clarifyStepNode`** — a small structured-output call asking "does this step need the user's input before proceeding" (`{needsClarification, question?, options?}`); if yes, `interrupt()`s with `{type: "question", id, question, options, allowCustomInput: true}`. Resume value: `{optionId?: string} | {customText?: string}`; the chosen answer is appended to `state.messages` as a `HumanMessage` so `runStepNode`'s tool loop can see it.
  - **Deliberately a separate node, not a tool the ReAct loop can call mid-step.** LangGraph replays an interrupted node from the top on resume; if `ask_user` were a tool available inside `runReactLoop`'s loop, resuming after that interrupt would re-run any tool calls made *earlier in that same iteration* — including non-idempotent ones (e.g. starting a time entry twice). `clarifyStepNode` makes no tool calls before its `interrupt()`, so its replay is safe. Keep this reasoning in mind before ever giving a mid-loop tool the ability to interrupt.
- **`runStepNode`** — runs `runReactLoop` (the shared model-call/tool-execution loop, also used by `followUpNode`) focused on the current step (a `focusNote` naming the step, appended as a `HumanMessage`), then marks that step `"completed"`.
- **`synthesisApprovalNode`** — the second HITL checkpoint (spec's worked example: "I found N sources, ready to synthesize — Approve/Reject"): `interrupt()`s with `{type: "approval", id, title, message, actions: [{id:"approve",...}, {id:"reject",...}]}`. Resume value: `{decision: "approve" | "reject"}`.
- **`synthesizeNode`** — one final `model.invoke()` over the full message history plus a trailing `HumanMessage` synthesis instruction (see the Gemini gotcha above), sets `state.finalAnswer`.
- **`followUpNode`** — a thread whose `finalAnswer` is already set routes new messages straight here instead of re-planning: a plain `runReactLoop` call with no step framing.

### The generic interaction model (`src/graph/interactionTypes.ts`)

One `AgentInteraction` discriminated union (`"approval" | "question" | "plan_edit"`) backs **every** `interrupt()` call site above — there's no bespoke payload shape per case. The frontend has its own structurally-identical copy in `web/src/interactionTypes.ts` (kept in sync by hand, not shared via a package — there's no shared-types package in this repo) and renders all three variants through one `useInterrupt()` call (`web/src/InteractionRenderer.tsx`), reading the raw interrupt value off `event.value` (the AG-UI *legacy* interrupt-event shape — `interrupt.value` on the newer standardized `Interrupt` object does **not** carry this payload; `event.value` does).

### CopilotKit runtime (`src/copilotRuntime.ts`)

- **`buildCopilotAgents({request})`** is the `AgentsFactory` CopilotKit's v2 runtime calls per request. It resolves the caller's session from the raw `Cookie` header itself (Express's `cookie-parser` middleware never runs on this bridged fetch `Request`) and returns one `OwnedLangGraphAgent` per graph id (`clockwork`, `research`, `qna` — must match `langgraph.json`'s keys and the React app's `agentId` props), each bound to that user via `assistantConfig.configurable.externalUserId`.
- **Deliberately does not throw when unauthenticated.** This factory also backs the runtime's `/info` endpoint, which the CopilotKit client SDK probes on every connect to auto-detect transport — and treats *any* non-2xx response as "not REST," silently falling back to a single-route POST protocol this server never registers (`mode: "multi-route"`), which then genuinely 404s with a confusing `agent_connect_failed` error that hides the real cause. So `/info` always succeeds and lists agents regardless of auth state; actual security is enforced downstream, in `OwnedLangGraphAgent.run()`, which hard-rejects any run whose `externalUserId` is missing.
- **`OwnedLangGraphAgent`** (subclasses `@ag-ui/langgraph`'s `LangGraphAgent`) does two things on every `run()`:
  1. **Thread-ownership enforcement** (`claimOrVerifyThreadOwnership`, `src/threadOwnership.ts`) — a client-supplied `threadId` must not let one user read/continue another user's conversation; LangGraph's thread store isn't scoped per-caller on its own. First use of a `threadId` claims it for that `externalUserId` (via a unique Mongo index, race-safe); every later use must match, or the run errors with `"This thread belongs to a different user."`
  2. **Event sanitization** (`sanitizeEvents`) — strips every `RAW` AG-UI event and every `rawEvent` field from other event types before they reach the browser. These carry the full underlying LangChain/LangGraph trace verbatim, **including the graph's system prompt text** — not chain-of-thought, but real prompt-engineering leakage to anyone opening devtools.
  - **Gotcha that bit this once**: `LangGraphAgent.clone()` (called by the CopilotKit runtime per-request/thread) only re-copies fields *it* knows about (`config`, `assistantConfig`, `graphId`, etc.) — it silently drops any extra field a subclass adds in its own constructor. `OwnedLangGraphAgent` originally took `externalUserId` as a constructor param and lost it on every clone (surfaced as a bogus "thread belongs to a different user" — the ownership record showed `externalUserId: null`). Fixed by reading `externalUserId` from `this.assistantConfig.configurable` instead, since `assistantConfig` *is* one of the fields `clone()` explicitly preserves. Don't reintroduce a bespoke instance field on this class without checking it survives `clone()`.
- **Resuming an interrupted run**: the client sends `forwardedProps: { command: { resume: <value> } }` on the next `/agent/<id>/run` call, same `threadId`, empty `messages`. (This is `@langchain/langgraph-sdk`'s run-payload shape, not an AG-UI-standard field — discovered by reading `@ag-ui/langgraph`'s source, not documented anywhere obvious.)

### The React app (`web/src/`)

- **`App.tsx`** — session check via `/auth/me`; renders `AuthView` or `ChatView`.
- **`AuthView.tsx`** — login/signup forms calling `/auth/login`, `/auth/signup` (`api.ts`).
- **`ChatView.tsx`** — an agent-switcher tab bar (clockwork/research/qna) wrapping `@copilotkit/react-core/v2`'s `<CopilotKit runtimeUrl="/api/copilotkit" credentials="include">` and `<CopilotChat>`. Each (user, agent) pair gets a stable `threadId` from `useStableThreadId.ts` (persisted in `localStorage`) so a page reload resumes the same LangGraph thread instead of losing it — passed to `<CopilotChatConfigurationProvider agentId={agentId} threadId={threadId}>`, which both `<CopilotChat>` and `<ResearchPlan>`/`<InteractionRenderer>` inherit from via context rather than needing explicit props.
- **`ResearchPlan.tsx`** — reads `agent.state.plan` reactively via `useAgent({agentId: "research", updates: [UseAgentUpdate.OnStateChanged]})` and renders the step list with live status icons. Only mounted on the research tab.
- **`InteractionRenderer.tsx`** — the one generic renderer for all three `AgentInteraction` variants (approval buttons, question with recommended options + custom-text fallback, plan editor with add/remove/reorder/skip + Save & Continue), via a single `useInterrupt()` call whose `render` prop dispatches on `event.value.type`.
- **`@copilotkit/react-core@1.67.1`'s stable public surface has already moved to an AG-UI-native "v2" API** (`@copilotkit/react-core/v2`, matching `@copilotkit/runtime/v2`/`/v2/express` server-side) — there is no GraphQL runtime anywhere in this integration, despite the package's "1.x" version number suggesting a more mature/settled classic API. Don't reach for `@copilotkit/react-core`'s bare (non-`/v2`) export or any GraphQL-runtime docs/examples you might find online; they don't apply here.

## Keeping the two implementations in sync

Because `src/agent*.ts` (legacy) and `src/graph/*.ts` (AG-UI) each independently call `buildTools()`/`buildMemoryTools()`/`composePreferenceContext()` and reference the same exported system-prompt constants, most tool/prompt changes only need to happen once (the constant/function is shared). What's **not** shared and needs updating in both places if it changes:
- The ReAct-loop shape itself (max tool iterations, how tool results are turned into `ToolMessage`s) — `simpleAgentGraph.ts`'s loop and `researchGraph.ts`'s `runReactLoop` are hand-copies of what `createAgent()` does internally in `src/agent*.ts`, not calls into shared code.
- Adding a fourth specialist agent means updating: `AGENT_RUNNERS` in `index.ts`, the `agent` enum in **both** `router.ts`'s and `planner.ts`'s Zod schemas (still duplicated, not shared from `constants.ts`), a new `src/agent*.ts`-shaped file, a new `src/graph/*.ts` file (probably via `buildSimpleAgentGraph` unless it needs research-style plan/HITL), a new entry in `langgraph.json`, a new key in `copilotRuntime.ts`'s `AGENT_GRAPH_IDS`, and a new tab in `web/src/ChatView.tsx`'s `AGENTS` array.

## Conventions to follow

- Every agent system prompt (`src/agent.ts`, `src/agents/researchAgent.ts`, `src/agents/qnaAgent.ts`, and by reuse, `src/graph/*.ts`) is written for the *end user's* voice: plain language, no raw JSON/IDs/GUIDs/tool payloads ever surfaced in a reply, short natural confirmations rather than structured reports. Preserve this tone when editing any prompt, and don't add headers/bullets/bold-label formatting to what's meant to be a short conversational reply. `researchGraph.ts`'s planning/clarification prompts additionally must never expose chain-of-thought — only observable, user-facing step titles/questions.
- `DEFAULT_TENANT_ID` (`src/constants.ts`, value `"default"`) is threaded through every memory/goal call site, on both execution paths. It's an explicit placeholder for future multi-tenancy, not a real feature yet — don't build tenant-switching UI/logic without checking with the user first, and don't remove the parameter thinking it's dead code.
- Structured-output LLM calls (routing, planning, memory classification, research plan generation, clarification checks) each build their own short-max-token `createModel()` instance rather than reusing the shared `model` export — keep this separation so their latency/cost stays small and independent of the main chat model's token budget.
- Memory/goal/episode writes always go through `MemoryService`/`GoalService` methods, never direct `getDb().collection(...)` calls from agent or route code — `collections.ts` is the only file that should call `getDb()` for those four collections. (`threadOwnership.ts`'s `thread_owners` collection is a newer, separate concern and reaches `getDb()` directly itself — it isn't one of the four memory/goal collections this rule covers.)
- When adding a new specialist agent, see "Keeping the two implementations in sync" above for the full list of places that need touching on both paths.
- Never trust the client for identity or thread ownership on the AG-UI path — `copilotRuntime.ts` always re-derives `externalUserId` from the verified session cookie, never from anything in the request body/props, and `OwnedLangGraphAgent` enforces per-thread ownership server-side rather than assuming a `threadId` the client sends is theirs.
