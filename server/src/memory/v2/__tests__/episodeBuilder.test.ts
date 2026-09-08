import { describe, expect, it } from "vitest";
import { buildEpisodeDetails, episodeContent } from "../episodeBuilder.js";
import type { MemoryEventRecord, ToolExecutionSummary } from "../../types.js";

function tool(toolName: string, status: ToolExecutionSummary["status"] = "success"): ToolExecutionSummary {
  return { toolName, status, startedAt: new Date(), durationMs: 5 };
}

function event(overrides: Partial<MemoryEventRecord> = {}): MemoryEventRecord {
  return {
    id: "evt1",
    tenantId: "default",
    userId: "u1",
    threadId: "t1",
    workspaceId: null,
    turnId: "turn1",
    userText: "Please start tracking time on the report.",
    assistantText: "I've started a time entry for the report.",
    toolSummaries: [],
    goalId: null,
    stepIndex: null,
    status: "processing",
    attempts: 0,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildEpisodeDetails", () => {
  it("carries the situation and outcome straight from the event text", () => {
    const episode = buildEpisodeDetails(event());
    expect(episode.situation).toContain("start tracking time");
    expect(episode.outcome).toContain("started a time entry");
  });

  it("lists the tool sequence as the action", () => {
    const episode = buildEpisodeDetails(event({ toolSummaries: [tool("start_time_entry"), tool("stop_time_entry")] }));
    expect(episode.action).toEqual(["start_time_entry", "stop_time_entry"]);
  });

  it("identifies a plain success with no failure and no lesson", () => {
    const episode = buildEpisodeDetails(event({ toolSummaries: [tool("start_time_entry")] }));
    expect(episode.failed).toBe(false);
    expect(episode.failedTool).toBeNull();
    expect(episode.resolution).toBeNull();
    // Nothing to generalize from one clean single-tool call.
    expect(episode.lesson).toBeNull();
  });

  it("derives a lesson from a multi-tool success, even with no failure", () => {
    const episode = buildEpisodeDetails(event({ toolSummaries: [tool("a"), tool("b")] }));
    expect(episode.failed).toBe(false);
    expect(episode.lesson).toMatch(/a -> b/);
  });

  it("identifies an unrecovered failure", () => {
    const episode = buildEpisodeDetails(event({ toolSummaries: [tool("start_time_entry", "error")] }));
    expect(episode.failed).toBe(true);
    expect(episode.failedTool).toBe("start_time_entry");
    expect(episode.resolution).toBeNull();
    expect(episode.lesson).toMatch(/not recovered/);
  });

  it("identifies a failure that was recovered later in the same turn", () => {
    const episode = buildEpisodeDetails(
      event({ toolSummaries: [tool("start_time_entry", "error"), tool("start_time_entry_retry", "success")] }),
    );
    expect(episode.failed).toBe(true);
    expect(episode.failedTool).toBe("start_time_entry");
    expect(episode.resolution).toBe("start_time_entry_retry");
    expect(episode.lesson).toMatch(/recovered/);
  });

  it("does not treat a success that happened before the failure as a resolution", () => {
    const episode = buildEpisodeDetails(
      event({ toolSummaries: [tool("lookup", "success"), tool("commit", "error")] }),
    );
    expect(episode.failed).toBe(true);
    expect(episode.resolution).toBeNull();
  });

  it("marks a goal-linked episode with the step objective and lesson on success", () => {
    const episode = buildEpisodeDetails(event({ goalId: "goal1", stepIndex: 2, toolSummaries: [tool("x")] }));
    expect(episode.goalId).toBe("goal1");
    expect(episode.stepIndex).toBe(2);
    expect(episode.objective).toMatch(/step 3/i);
    expect(episode.lesson).toMatch(/step 3/i);
  });

  it("truncates long situation/outcome text rather than storing it unbounded", () => {
    const episode = buildEpisodeDetails(event({ userText: "x".repeat(1000), assistantText: "y".repeat(1000) }));
    expect(episode.situation.length).toBeLessThan(500);
    expect(episode.outcome.length).toBeLessThan(500);
  });
});

describe("episodeContent", () => {
  it("combines situation and outcome into one readable line", () => {
    const episode = buildEpisodeDetails(event());
    const content = episodeContent(episode);
    expect(content).toContain("->");
    expect(content).toContain(episode.situation);
    expect(content).toContain(episode.outcome);
  });

  it("appends the lesson in parentheses when one exists", () => {
    const episode = buildEpisodeDetails(event({ toolSummaries: [tool("a"), tool("b")] }));
    const content = episodeContent(episode);
    expect(content).toMatch(/\(Completed by chaining/);
  });

  it("omits the parenthetical entirely when there is no lesson", () => {
    const episode = buildEpisodeDetails(event({ toolSummaries: [tool("a")] }));
    const content = episodeContent(episode);
    expect(content).not.toContain("(");
  });
});
