# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

- `server/` — the chat agent backend (Express + LangGraph + MongoDB). This is where almost all work happens.
- `web/` — a minimal static chat frontend (`index.html`, `chat.js`, `style.css`), vanilla JS, no build step, served directly by the Express app as static files.
- `System1.MCP/` — a **separate, sibling** project: an MCP server (Express + `@modelcontextprotocol/sdk`, backed by `better-sqlite3`) that exposes System1 ClockWork time-tracking tools (start/stop/delete entry, list projects/tasks). `server/` is purely an MCP *client* of it, talking over HTTP; the URL is configured via `MCP_SERVER_URL`. Treat it as out-of-repo unless a task explicitly touches it — it has its own `package.json`/`tsconfig.json`/build.

## Commands (run from `server/`)

- `npm run build` — compile TypeScript to `dist/` (`tsc -p tsconfig.json`)
- `npm run dev` — compile in watch mode (does not restart the server itself, just recompiles)
- `npm start` — run the compiled server: `node --env-file=.env dist/index.js`. Requires a `.env` file — copy `.env.example` and fill in `JWT_SECRET`, `OPENROUTER_API_KEY` (or `GEMINI_API_KEY` if `MODEL_PROVIDER=gemini`), and point `MCP_SERVER_URL` at a running `System1.MCP` instance.
- No test suite, linter, or formatter is configured anywhere in this repo. Don't assume `npm test`/`npm run lint` exist.
- There is no `nodemon`/live-reload wired up for `dist/index.js` — after editing `.ts` you need a fresh `npm run build` (or a running `npm run dev` watch) *and* a server restart to see changes when running via `npm start`.

## Runtime dependencies

- **MongoDB** — required at startup (`connectDb()` in `src/db.ts` throws if it can't connect); stores users, conversation history, memories, episodes, and goals. Default `mongodb://localhost:27017/`, db name `chat_agent`.
- **System1.MCP server** — required for the `clockwork` and `research` agents' tool calls to work (both call `buildTools()`); `qna` never needs it. `listMcpTools()` is called once at first use and cached, so if the MCP server isn't up yet when a request first triggers it, that failure isn't retried per-request — a restart is needed after bringing MCP up.
- **OpenRouter or Gemini** — the chat model provider. Selected via `MODEL_PROVIDER` env var (`"openrouter"` default, or `"gemini"`). `config.ts` throws at startup if the corresponding API key is missing.

## Architecture

### Request flow (`src/index.ts`)

`POST /api/chat`, behind `requireAuth`, is the single entry point for chat. Per request:

1. **Body**: `{ messages: Array<{role: "user"|"assistant", content: string}>, agent?: "clockwork"|"research"|"qna" }`. `messages` is the full running transcript from the client (not just the new message) — the client is expected to resend history each turn; server-side conversation memory (see below) is a separate, independent log, not what's replayed into the LLM context on subsequent turns.
2. **Agent selection** (`AGENT_RUNNERS` map — `clockwork` → `runAgent`, `research` → `runResearchAgent`, `qna` → `runQnaAgent`), in priority order:
   - Explicit `agent` field in the request body always wins and **skips goal tracking entirely** (no goal is read, created, or advanced on this turn).
   - Otherwise, if the user has an active `GoalRecord` (see Goals below) with a pending current step, that step's `agent` is used, and the step's `description` is appended to the outgoing user message as `(Current step to work on: ...)` so the agent knows what it's meant to accomplish right now — the raw latest user message is *not* what drives agent choice in this branch.
   - Otherwise, `planGoal()` is tried first (may turn a single message into a whole multi-step goal); if it declines, `routeToAgent()` makes a single-agent routing choice.
3. **Streaming response**: sets SSE headers (`Content-Type: text/event-stream`, no caching, keep-alive) and writes newline-delimited `data: {...}\n\n` JSON events in this order:
   - `{ agent, step }` — emitted immediately, before any model output, so the client can show which agent/step is active.
   - `{ delta }` — one per streamed AI-message chunk of text (non-`"ai"`-typed chunks, e.g. tool-call chunks, are filtered out entirely; nothing is sent to the client about tool calls in progress).
   - `{ goalProgress: { title, status, doneSteps, totalSteps, nextStep } }` — only when this turn was driven by an active goal; emitted **after** the agent finishes and the goal is advanced via `goalService.advanceCurrentStep()`.
   - `{ error }` — only on a caught exception from the agent run; the raw error is logged server-side (`console.error`) but never leaked to the client.
   - `{ done: true }` — always the final event, in both success and error paths (`finally` calls `res.end()`).
4. `extractText()` pulls plain text out of an `AIMessageChunk`'s `content`, which may be a string or an array of content parts — only `{type: "text"}` parts are concatenated; this same helper is duplicated in `src/agents/shared.ts` (used by the agents themselves) — keep both in sync if the message-content shape assumptions ever change.

### Three specialist agents

All three are built with `createReactAgent` from `@langchain/langgraph/prebuilt` and follow an identical shape: build a tool list, load preference context, prepend a system prompt, stream with `streamMode: "messages"`, tee the stream through `wrapWithConversationMemory`. The differences are entirely in system prompt and tool set:

- **clockwork** (`src/agent.ts`) — tools: MCP tools (`buildTools`) + memory tools. System prompt is written to act immediately on requests using only the arguments the user gave (never asks the user to fill in optional tool args — omit and let tool defaults apply; only asks a clarifying question for a *missing required* argument), and to never leak raw tool JSON/IDs/GUIDs to the user — replies are 1–2 plain sentences, no headers/bullets/bold for simple confirmations. Session ID for conversation memory is just `externalUserId` (shared with no other agent). This is the **default** agent when routing is ambiguous.
- **research** (`src/agents/researchAgent.ts`) — tools: MCP tools + memory tools (same as clockwork). System prompt instructs it to check memory (`recall_memory`, `get_similar_experiences`) *before* using data tools, reuse a working prior approach when one exists, cite what it found, call `remember_fact` only for durable cross-task facts (not one-off findings), and be explicit about uncertainty rather than fabricating. Session ID is `${externalUserId}:research` (a separate conversation log from clockwork/qna). Unlike the other two, it passes an `episode` to `wrapWithConversationMemory`, so every research run also gets recorded as an `EpisodeRecord` for future `get_similar_experiences` lookups.
- **qna** (`src/agents/qnaAgent.ts`) — tools: memory tools **only**, no MCP tools — it cannot take any real action. System prompt tells it to check `recall_memory` before answering and, if asked to do something requiring action, to say so and point the user at the ClockWork assistant instead of attempting it. Session ID is `${externalUserId}:qna`.

Shared plumbing lives in two files:
- `src/agents/shared.ts` — re-exports `DEFAULT_TENANT_ID`, `extractText()`, and `wrapWithConversationMemory()`: an async-generator wrapper that passes every stream chunk through untouched (so the caller/SSE loop sees no difference) while accumulating the assistant's full text and the set of tool names called, then *after the stream ends*, persists the assistant's final text to conversation memory and — only if an `episode` option was passed — records an `EpisodeRecord` (outcome truncated to 500 chars, `success: true` unconditionally — there's no failure-path episode recording currently, so `findSimilarEpisodes` results are optimistic by construction).
- `src/agents/sharedTools.ts` — `buildTools(externalUserId)` calls `listMcpTools()` (cached, user-independent) and wraps each MCP tool description as a LangChain `tool()`, binding `externalUserId` via closure so every call is scoped to that chat user. A non-linked-account result from the MCP call is turned into a plain-English tool return value pointing the user at a link URL, rather than throwing — the agent treats it as a normal tool result to relay, not an error.

### Routing vs. planning (`src/router.ts`, `src/planner.ts`)

Both use small, cheap, separate LLM instances (`createModel(maxTokens)` from `src/llm.ts` — 300 tokens for planning, 100 for routing) with `.withStructuredOutput(zodSchema)`, distinct from the main chat `model` export (500 tokens). Keep that separation when touching either file — don't reuse the shared `model` here.

- **`planGoal(message)`** (`src/planner.ts`) — asks whether the message needs decomposition into 2–5 sequential steps across agents (`isMultiStep`, `title`, `steps: [{description, agent}]`). Returns `null` (not a goal) whenever `isMultiStep` is false *or* fewer than 2 steps come back, even if the model said `isMultiStep: true` — that inconsistency is treated as "not actually multi-step." On any LLM error, logs and returns `null` (falls through to routing), so planning failures never block a response.
- **`routeToAgent(message)`** (`src/router.ts`) — one-shot classification into `clockwork | research | qna`. Defaults to `"clockwork"` both on an ambiguous/short-follow-up message (per its own prompt instructions) and on any LLM error (in the `catch`) — so `clockwork` is the system's overall fallback agent in every failure mode.
- Both are called from `index.ts` **only** when there's no active goal and no explicit `agent` override — an active goal's current step always wins over a fresh routing/planning decision.

### LLM provider (`src/llm.ts`, `src/config.ts`)

`createModel(maxTokens)` returns a `ChatGoogleGenerativeAI` (Gemini) or `ChatOpenAI` configured against OpenRouter's baseURL (`https://openrouter.ai/api/v1`), chosen by `config.modelProvider`. `config.ts` validates at import time (module load, not lazily) that the API key for whichever provider is selected exists, and throws immediately if `MCP_SERVER_URL` or `JWT_SECRET` are unset — so a misconfigured `.env` fails fast on startup rather than surfacing as a runtime error mid-conversation. The default export `model` is a fixed 500-max-token instance shared by all three agents' main chat loop; routing/planning/memory-classification each build their *own* short-token instance rather than reusing it.

### MCP client (`src/mcpClient.ts`)

- A **new** `StreamableHTTPClientTransport` + `Client` connection is opened and closed (`withClient`) for *every* call — there's no persistent/pooled connection. Don't assume connection reuse when reasoning about MCP server load or latency.
- The chat user's external ID is sent as an `X-External-User-Id` header on every call except tool discovery (`listMcpTools` passes the literal placeholder string `"tool-discovery"`, since the tool list itself doesn't depend on which user is asking) — the MCP server uses that header to resolve the caller's linked System1 account.
- `listMcpTools()` result is memoized in a module-level `cachedTools` variable for the process lifetime — if tools are added/changed on the MCP server side, the chat-agent server needs a restart to pick them up.
- `callMcpTool()` expects exactly one `{type: "text"}` content item in the MCP result and JSON-parses it; it throws if none is found. There is no handling for multiple content items or non-text content types.
- `isNotLinkedResult()` is a structural type guard (checks for `error === "not_linked"` and a string `linkUrl`), not a schema-validated one — any MCP tool result that happens to match that shape will be treated as "not linked," so this convention needs to stay consistent on the MCP server side too.

### Memory system (`src/memory/`)

A deliberately narrow layer over four MongoDB collections (`src/memory/collections.ts`; indexes created once at startup via `ensureMemoryIndexes()` in `index.ts`), all accessed only through `MemoryService` (`memoryService.ts`) — no other file should reach `getDb()` for these collections directly.

- **Conversation memory** (`conversation_messages`) — flat append-only log of `{role, content}` per `sessionId`. `getRecentMessages()` (default limit 20, indexed on `{sessionId, createdAt}`) exists but note: **nothing in the codebase currently calls it** — conversation memory is written-to but not read back into any agent's context. The LLM's actual context each turn comes entirely from the client-resent `messages` array in the request body, not from this store. Keep that in mind before assuming "the agent remembers the conversation" implies this table is involved.
- **Semantic/preference memory** (`memories` collection, `MemoryRecord`, `type: "semantic" | "preference" | "episode"` — note `"episode"` is a valid `MemoryType` value but episodes actually live in their own separate `episodes` collection; don't conflate the two) — facts keyed by `subject`+`predicate`+`object`.
  - `remember()` conflict resolution, keyed on `{tenantId, userId, subject, predicate, status: "active"}`: if an active fact with the same subject+predicate already has the *same* object, it's reinforced in place (confidence/importance bumped to the max of old/new, no new row). If the object differs, the new fact only becomes `"active"` and supersedes the old one (`status: "superseded"`, `validTo` set, never deleted) when its `confidence >= existing.confidence`; otherwise the *new* record is inserted already marked `"superseded"` — i.e. a low-confidence contradicting fact is stored for history but never becomes the visible truth.
  - `recall()` is a case-insensitive regex substring match over the flattened `content` field (`"{subject} {predicate}: {object}"`-shaped string built in `remember()`), ranked by `importance desc, confidence desc, updatedAt desc` — not embeddings/vector search, so recall quality depends on the query sharing literal substrings with stored content.
  - `getActiveFacts()` is what feeds `composePreferenceContext()` (only `type: "preference"`, top 10 by importance) into every agent's system prompt on every turn — so a `remember_fact` call from any agent has an immediate, standing effect on all three agents' future prompts, not just the one that called it.
  - `getTimeline()` returns full active+superseded history for a subject+predicate, oldest first — the only read path that surfaces superseded facts.
- **Episodic memory** (`episodes` collection, `EpisodeRecord`) — currently only ever written by the **research** agent (via the `episode` option to `wrapWithConversationMemory`); clockwork and qna never record episodes. `findSimilarEpisodes()` does a regex match on `task`, most recent first, limit 3. Every recorded episode has `success: true` hardcoded — there is no code path that records a failed episode, so don't rely on `success` as meaningful signal yet.
- **Extraction pipeline** — after `clockwork`'s `runAgent()` logs the user's message to conversation memory, it fires `memoryService.extractAndPersist()` **without awaiting it** (`.catch()`-only, explicitly fire-and-forget so extraction latency never blocks the chat response). This calls `LlmMemoryExtractor.extract()` (`classifier.ts`, its own `createModel(300)` structured-output call) to pull candidate `{memoryType, subject, predicate, object, confidence, reason}` facts out of a single message, filters out `memoryType: "ignore"`, scores each via `DefaultImportanceScorer` (base 0.3, +0.3 if `explicitStatement` — always `true` from this call site, +0.2 if `memoryType === "preference"`, + up to +0.2 from confidence — clamped to [0,1]), and only persists facts scoring `>= 0.5` (`MIN_IMPORTANCE_TO_PERSIST`). **Only the clockwork agent triggers this pipeline** — research/qna never auto-extract facts from user messages (they only get facts written when the agent itself explicitly calls the `remember_fact` tool).
- Both `IMemoryExtractor` and `IMemoryImportanceScorer` are injected into `MemoryService`'s constructor with default implementations — swap them by passing different instances, not by editing `MemoryService` itself. This is a deliberate "no giant MemoryService" rule per the code's own comment — add new memory capabilities as separate injected collaborators, not new methods bolted onto the class.
- **Memory tools** (`memoryTools.ts`) are the *only* surface an LLM ever gets onto memory (comment in the file is explicit about this) — `remember_fact`, `recall_memory`, `get_similar_experiences`, `get_active_goals`. `remember_fact` always writes `type: "preference"`, `source: "agent"`, `importance: 0.8` regardless of what the LLM stores — there's no tool for writing `type: "semantic"` facts or episodes directly.

### Goals (`src/memory/goalService.ts`)

`GoalRecord`s (`goals` collection) represent a persistent, multi-step objective spanning turns/sessions. Each `GoalStep` has `{description, agent, status: "pending"|"done"}`.

- `getActiveGoal()` returns the most recently *created* active goal (sorted `createdAt: -1`) — if a user somehow has more than one active goal, index.ts always resumes the newest, and the others are invisible to the main chat flow (though still visible via the `get_active_goals` tool's `listActiveGoals`, which lists up to 5).
- `advanceCurrentStep(goalId)` marks the current step `"done"` and increments `currentStepIndex`; the goal's own `status` flips to `"done"` once the index runs past the last step. There's no step-level failure state — a step can only be `"pending"` or `"done"`, so a failed tool call inside a goal step still gets marked done on the next `advanceCurrentStep()` call (called unconditionally after every successful *agent run*, not conditioned on whether the step's task actually succeeded).
- `abandonGoal()` exists (sets `status: "abandoned"`) but nothing in `index.ts` or the memory tools currently calls it — there's no user-facing way to cancel a goal yet; an active goal will keep being resumed on every turn until its steps run out.

### Auth (`src/auth.ts`, `src/db.ts`)

Cookie-based JWT sessions, no refresh-token flow — a single 7-day-TTL JWT (`jwt.sign({sub: userId}, ..., {expiresIn: SESSION_TTL_SECONDS})`) stored in an `httpOnly`, `sameSite: "lax"` cookie named `session`. `requireAuth` re-validates the user still exists in Mongo on every request (not just JWT signature/expiry) via `findUserById`, so a deleted user is deauthenticated immediately even with a still-valid token. Passwords are bcrypt-hashed (cost factor 10) in `createUser`; there's no password-reset or email-verification flow. `/auth/me` never 401s — it always returns 200 with `{authenticated: boolean, ...}`, distinct from every other route which 401s via `requireAuth`.

## Conventions to follow

- Every agent system prompt (`src/agent.ts`, `src/agents/researchAgent.ts`, `src/agents/qnaAgent.ts`) is written for the *end user's* voice: plain language, no raw JSON/IDs/GUIDs/tool payloads ever surfaced in a reply, short natural confirmations rather than structured reports. Preserve this tone when editing any prompt, and don't add headers/bullets/bold-label formatting to what's meant to be a short conversational reply.
- `DEFAULT_TENANT_ID` (`src/constants.ts`, value `"default"`) is threaded through every memory/goal call site. It's an explicit placeholder for future multi-tenancy, not a real feature yet — don't build tenant-switching UI/logic without checking with the user first, and don't remove the parameter thinking it's dead code.
- Structured-output LLM calls (routing, planning, memory classification) each build their own short-max-token `createModel()` instance rather than reusing the shared `model` export — keep this separation so their latency/cost stays small and independent of the main chat model's token budget.
- Memory/goal/episode writes always go through `MemoryService`/`GoalService` methods, never direct `getDb().collection(...)` calls from agent or route code — `collections.ts` is the only file that should call `getDb()` for these four collections.
- When adding a new specialist agent, follow the existing shape exactly: build its tool list, call `composePreferenceContext()`, prepend a system prompt, stream via `agent.stream(..., {streamMode: "messages"})`, and return `wrapWithConversationMemory(...)` — then add it to `AGENT_RUNNERS` in `index.ts` and to the `agent` enum in **both** `router.ts`'s and `planner.ts`'s Zod schemas (they're currently duplicated, not shared from `constants.ts`'s `AGENT_NAMES`, so all three places need updating together).
