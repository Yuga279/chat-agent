/**
 * A minimal in-process counter registry for the memory pipeline - deliberately not a Prometheus/
 * OpenTelemetry client or any other new dependency, since nothing else in this repo exports
 * metrics and adding a metrics framework for one subsystem would be exactly the kind of
 * unnecessary infrastructure the project's own ground rules warn against. This exists so a failure
 * mode that is *designed* to degrade silently for the user (a timed-out retrieval leg, a
 * dead-lettered event) is not also silent for whoever operates this service - `getSnapshot()` is
 * logged in the worker's periodic heartbeat (see memoryWorker.ts's `runForever`).
 *
 * `turnId` (already on every `MemoryEventRecord`, `MemoryProvenance.sourceTurnIds`, and inherited
 * by every item/revision an event produces) is this pipeline's correlation id end to end - a
 * second, parallel identifier was deliberately not introduced here.
 */
class MemoryMetrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  getSnapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /** Test-only: production code never needs to reset counters mid-process. */
  reset(): void {
    this.counters.clear();
  }
}

export const memoryMetrics = new MemoryMetrics();
