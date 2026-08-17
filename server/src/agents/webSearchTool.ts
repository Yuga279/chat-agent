import { tool } from "@langchain/core/tools";
import { z } from "zod";

const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const MAX_RESULTS = 5;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, "")).trim();
}

/** DuckDuckGo's HTML endpoint (no API key, no official search API exists) wraps result links in
 * a redirect (`//duckduckgo.com/l/?uddg=<encoded target>&...`) - unwrap it so callers get the
 * real destination URL, not DuckDuckGo's own click-tracking link. */
function unwrapRedirect(href: string): string {
  const match = href.match(/uddg=([^&]+)/);
  if (!match) return href;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return href;
  }
}

/** Scrapes DuckDuckGo's no-JS HTML results page. There's no free official DuckDuckGo web-search
 * API (their Instant Answer API only returns abstracts/definitions, not ranked web results), so
 * this parses the same static HTML their "lite"/no-JS clients render - a regex scan rather than
 * an HTML parser to avoid pulling in a new dependency for one page shape. */
export async function searchDuckDuckGo(query: string, maxResults = MAX_RESULTS): Promise<WebSearchResult[]> {
  const response = await fetch(`${DUCKDUCKGO_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" },
    body: `q=${encodeURIComponent(query)}`,
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed (${response.status})`);
  }

  const html = await response.text();
  const results: WebSearchResult[] = [];

  // Split on each result block's opening marker rather than trying to balance nested </div>s -
  // the block's own closing tag isn't distinguishable from its children's by regex alone. Each
  // chunk then runs up to (but past) the *next* result's opening marker, which is fine since we
  // only look for the first title/snippet anchor within it.
  const blocks = html.split(/<div class="result results_links/).slice(1);

  // Attribute order on result__a/result__snippet anchors isn't guaranteed (DuckDuckGo has been
  // observed emitting `rel="nofollow" class="result__a" href="..."` as well as
  // `class="result__a" href="..."`), so match each anchor's attributes in any order rather than
  // assuming `class` comes first.
  const titleAnchorPattern = /<a\b(?=[^>]*\bclass="result__a")(?=[^>]*\bhref="([^"]+)")[^>]*>([\s\S]*?)<\/a>/;
  const snippetAnchorPattern = /<a\b(?=[^>]*\bclass="result__snippet")[^>]*>([\s\S]*?)<\/a>/;

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const titleMatch = block.match(titleAnchorPattern);
    if (!titleMatch) continue;
    const snippetMatch = block.match(snippetAnchorPattern);

    results.push({
      title: stripTags(titleMatch[2]),
      url: unwrapRedirect(titleMatch[1]),
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : "",
    });
  }

  return results;
}

/** Web-search tool available to any graph that wants it (assistantGraph.ts, researchGraph.ts) -
 * unlike buildTools()'s MCP tools, this needs no per-user context, so it's a plain singleton
 * rather than something built per externalUserId. */
export function buildWebSearchTool() {
  return tool(
    async ({ query }: { query: string }) => {
      try {
        const results = await searchDuckDuckGo(query);
        if (results.length === 0) return "No web search results found for that query.";
        return JSON.stringify(results);
      } catch (error) {
        console.error("web_search tool failed:", error);
        return "TOOL_CALL_FAILED: web search is temporarily unavailable. Tell the user and continue without it.";
      }
    },
    {
      name: "web_search",
      description:
        "Searches the public web via DuckDuckGo and returns the top results (title, url, snippet). Use this for " +
        "questions about current events, facts, or anything outside your own knowledge or the ClockWork tools.",
      schema: z.object({ query: z.string().describe("The search query") }),
    },
  );
}
