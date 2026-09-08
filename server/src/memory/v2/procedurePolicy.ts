import type { ProcedureValidationStatus } from "../types.js";

/**
 * Deterministic governance for procedural memory's promotion pipeline: candidate -> validation ->
 * active, and active -> deprecated on a regression. Deliberately not model-based, the same
 * reasoning as MemoryPolicy's sensitivity gate: the judgement here (how much repeated evidence is
 * enough) is a policy decision, not a classification task, and a policy decision should be
 * auditable and reproducible rather than left to a model call.
 *
 * The one rule every other rule here exists to serve: a single successful run must never become an
 * authoritative procedure. That is what `MIN_SUCCESSES_FOR_PROMOTION > 1` enforces structurally -
 * there is no code path that can promote to "active" on one success, regardless of confidence.
 */

/** How many *consecutive-of-record* clean successes (zero recorded failures) a candidate needs
 * before it is trusted as an active procedure. */
export const MIN_SUCCESSES_FOR_PROMOTION = 3;

/** How many failures a procedure that has never had a recorded success may accumulate before it is
 * rejected outright - a pattern that has only ever failed is not "still building evidence." */
export const MAX_FAILURES_WITH_NO_SUCCESS = 2;

/**
 * Evaluates the next validation status given an outcome history. Pure function of the counts and
 * the current status - no I/O, no model call - so it is trivially unit-testable and so the same
 * inputs always produce the same governance decision.
 */
export function evaluateProcedureStatus(
  current: ProcedureValidationStatus,
  successCount: number,
  failureCount: number,
): ProcedureValidationStatus {
  // Rejection is terminal: a rejected pattern does not quietly earn its way back to candidacy by
  // being observed again. Un-rejecting one is a deliberate, out-of-band action (a manual edit via
  // the memories API), not something this automatic evaluator ever does on its own.
  if (current === "rejected") return "rejected";

  // A candidate that has only ever failed, and failed enough times, is not "still building
  // evidence" - it is a pattern that doesn't work. Reject it before it can accumulate forever.
  if (successCount === 0 && failureCount >= MAX_FAILURES_WITH_NO_SUCCESS) return "rejected";

  if (current === "active") {
    // An active procedure that starts failing more often than it succeeds has likely stopped
    // matching reality (the environment changed, a tool's behavior changed) - demote rather than
    // reject outright, since the procedure itself may not have been wrong.
    if (failureCount > 0 && failureCount >= successCount) return "deprecated";
    return "active";
  }

  if (current === "deprecated") {
    // A deprecated procedure can earn its way back only by re-clearing the same bar a fresh
    // candidate would - repeated success with no offsetting failure record since.
    return successCount >= MIN_SUCCESSES_FOR_PROMOTION && failureCount === 0 ? "active" : "deprecated";
  }

  // current === "candidate": promote only on a clean run of the required length. Any recorded
  // failure at all blocks promotion - this is deliberately stricter than a failure *rate* bar,
  // since "repeated success" in the spec means an unbroken record, not a majority.
  return successCount >= MIN_SUCCESSES_FOR_PROMOTION && failureCount === 0 ? "active" : "candidate";
}
