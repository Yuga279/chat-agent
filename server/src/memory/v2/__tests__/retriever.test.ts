import { describe, expect, it } from "vitest";
import { MemoryRetriever } from "../retriever.js";
import { memoryItem } from "./fixtures.js";

// fuseAndBudget is private; tests reach it via `as any` rather than exporting it purely for
// testability - it is the one piece of retrieval with real, easy-to-get-wrong arithmetic (RRF
// combination, expiry filtering, token budgeting), so it earns a direct unit test.
function fuse(retriever: MemoryRetriever, textResults: ReturnType<typeof memoryItem>[], vectorResults: ReturnType<typeof memoryItem>[]) {
  return (retriever as any).fuseAndBudget(textResults, vectorResults);
}

describe("MemoryRetriever.fuseAndBudget", () => {
  it("ranks an item found by both legs above one found by only one", () => {
    const retriever = new MemoryRetriever();
    const both = memoryItem({ id: "both", content: "found by both", importance: 0.5, confidence: 0.5 });
    const textOnly = memoryItem({ id: "text-only", content: "found by text only", importance: 0.5, confidence: 0.5 });

    const ranked = fuse(retriever, [both, textOnly], [both]);

    expect(ranked[0].id).toBe("both");
  });

  it("lets relevance (rank) outrank a weakly-matching item with higher stored importance", () => {
    // The defect this replaced: fusion discarded Atlas's ranking once a candidate cleared the
    // search filter and sorted purely on importance/confidence/recency, so a strong top-ranked
    // match could lose to a weaker match that merely had a higher importance score.
    const retriever = new MemoryRetriever();
    const relevant = memoryItem({ id: "relevant", content: "exact match", importance: 0.3, confidence: 0.5 });
    const weak = memoryItem({ id: "weak", content: "loosely related but important", importance: 0.95, confidence: 0.95 });

    // relevant tops both legs (rank 1 in each); weak only shows up once, at the bottom of the text
    // leg - present, but far weaker relevance despite its higher stored importance/confidence.
    const ranked = fuse(retriever, [relevant, weak], [relevant]);

    expect(ranked.map((i: any) => i.id)).toEqual(["relevant", "weak"]);
  });

  it("de-duplicates an item present in both result lists", () => {
    const retriever = new MemoryRetriever();
    const item = memoryItem({ id: "dup" });

    const ranked = fuse(retriever, [item], [item]);

    expect(ranked).toHaveLength(1);
  });

  it("excludes an item whose validTo has already passed", () => {
    const retriever = new MemoryRetriever();
    const expired = memoryItem({ id: "expired", validTo: new Date(Date.now() - 1000) });
    const active = memoryItem({ id: "active-item", validTo: null });

    const ranked = fuse(retriever, [expired, active], []);

    expect(ranked.map((i: any) => i.id)).toEqual(["active-item"]);
  });

  it("excludes a procedure that hasn't been promoted to active", () => {
    // Discovered while writing the final review: without this, the promotion pipeline
    // (procedurePolicy.ts) would be purely cosmetic - a candidate or explicitly rejected
    // procedure was exactly as retrievable as one that actually cleared governance.
    const retriever = new MemoryRetriever();
    const candidate = memoryItem({
      id: "candidate-proc",
      kind: "procedural",
      subtype: "procedure",
      procedure: { steps: ["a", "b"], successCount: 1, failureCount: 0, validationStatus: "candidate" },
    });
    const rejected = memoryItem({
      id: "rejected-proc",
      kind: "procedural",
      subtype: "procedure",
      procedure: { steps: ["c", "d"], successCount: 0, failureCount: 2, validationStatus: "rejected" },
    });
    const active = memoryItem({
      id: "active-proc",
      kind: "procedural",
      subtype: "procedure",
      procedure: { steps: ["e", "f"], successCount: 3, failureCount: 0, validationStatus: "active" },
    });

    const ranked = fuse(retriever, [candidate, rejected, active], []);

    expect(ranked.map((i: any) => i.id)).toEqual(["active-proc"]);
  });

  it("falls back to metadata ranking when neither leg produced results", () => {
    const retriever = new MemoryRetriever();
    const ranked = fuse(retriever, [], []);
    expect(ranked).toEqual([]);
  });

  it("caps injected items at the configured maximum", () => {
    const retriever = new MemoryRetriever();
    const items = Array.from({ length: 10 }, (_, i) => memoryItem({ id: `item-${i}`, content: `fact number ${i}` }));

    const ranked = fuse(retriever, items, []);

    expect(ranked.length).toBeLessThanOrEqual(5);
  });

  it("stops adding items once the token budget would be exceeded", () => {
    const retriever = new MemoryRetriever();
    // ~4 chars/token estimate (tokenBudget.ts) - sized so this one item alone exceeds the
    // 400-token retrieved-items budget (1700 chars -> ~425 estimated tokens).
    const huge = memoryItem({ id: "huge", content: "x".repeat(1700) });
    const small = memoryItem({ id: "small", content: "short fact" });

    const ranked = fuse(retriever, [huge, small], []);

    // huge busts the budget on its own and is skipped entirely (the loop's `continue`, not a
    // break, keeps checking later items); small fits and is kept. The naive "include everything"
    // behavior must not happen.
    expect(ranked.map((i: any) => i.id)).toEqual(["small"]);
  });
});
