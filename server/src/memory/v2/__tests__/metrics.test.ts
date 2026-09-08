import { beforeEach, describe, expect, it } from "vitest";
import { memoryMetrics } from "../metrics.js";

describe("MemoryMetrics", () => {
  beforeEach(() => {
    memoryMetrics.reset();
  });

  it("starts empty", () => {
    expect(memoryMetrics.getSnapshot()).toEqual({});
  });

  it("increments a counter from zero", () => {
    memoryMetrics.increment("events_enqueued");
    expect(memoryMetrics.getSnapshot()).toEqual({ events_enqueued: 1 });
  });

  it("accumulates repeated increments of the same counter", () => {
    memoryMetrics.increment("events_enqueued");
    memoryMetrics.increment("events_enqueued");
    memoryMetrics.increment("events_enqueued", 3);
    expect(memoryMetrics.getSnapshot().events_enqueued).toBe(5);
  });

  it("keeps distinct counters independent", () => {
    memoryMetrics.increment("a");
    memoryMetrics.increment("b", 2);
    expect(memoryMetrics.getSnapshot()).toEqual({ a: 1, b: 2 });
  });
});
