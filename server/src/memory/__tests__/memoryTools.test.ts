import { beforeEach, describe, expect, it, vi } from "vitest";

const interrupt = vi.fn();
vi.mock("@langchain/langgraph", () => ({ interrupt }));

const recordRejection = vi.fn(async (_tenantId: string, _userId: string, _candidate: unknown, _reason: string) => {});
const findActiveItemByCanonicalKey = vi.fn(async () => null);
const upsertByCanonicalKey = vi.fn(async () => ({ id: "new-id" }));
vi.mock("../v2/repository.js", () => ({
  memoryRepository: { recordRejection, findActiveItemByCanonicalKey, upsertByCanonicalKey },
}));

const { buildMemoryTools } = await import("../memoryTools.js");

function rememberFactTool() {
  const [tool] = buildMemoryTools("default", "u1", { scope: "user", workspaceId: null, threadId: "t1" });
  return tool;
}

describe("remember_fact - secret refusal", () => {
  beforeEach(() => {
    interrupt.mockReset();
    recordRejection.mockClear();
    findActiveItemByCanonicalKey.mockClear();
    upsertByCanonicalKey.mockClear();
  });

  it("refuses a secret outright without ever pausing for consent", async () => {
    const tool = rememberFactTool();

    const result = await tool.invoke({ subject: "server", predicate: "api_key", object: "sk-abcdefghijklmnopqrstuvwx1234" });

    expect(result).toMatch(/credential|secret/);
    expect(interrupt).not.toHaveBeenCalled();
    expect(upsertByCanonicalKey).not.toHaveBeenCalled();
    expect(recordRejection).toHaveBeenCalledTimes(1);
    expect(recordRejection.mock.calls[0][3]).toMatch(/credential|secret/);
  });

  it("still offers a consent prompt for merely-sensitive content", async () => {
    interrupt.mockReturnValueOnce({ action: "approve" });
    const tool = rememberFactTool();

    const result = await tool.invoke({ subject: "user", predicate: "has_condition", object: "recently received a diagnosis" });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(upsertByCanonicalKey).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/Remembered/);
  });

  it("writes nothing when the consent prompt is rejected", async () => {
    interrupt.mockReturnValueOnce({ action: "reject" });
    const tool = rememberFactTool();
    upsertByCanonicalKey.mockClear();

    const result = await tool.invoke({ subject: "user", predicate: "has_condition", object: "recently received a diagnosis" });

    expect(upsertByCanonicalKey).not.toHaveBeenCalled();
    expect(result).toMatch(/won't remember/);
  });

  it("writes immediately for ordinary, non-sensitive content", async () => {
    const tool = rememberFactTool();
    upsertByCanonicalKey.mockClear();

    const result = await tool.invoke({ subject: "user", predicate: "prefers_currency", object: "INR" });

    expect(interrupt).not.toHaveBeenCalled();
    expect(upsertByCanonicalKey).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/Remembered/);
  });
});
