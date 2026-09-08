import { describe, expect, it } from "vitest";
import { MAX_FAILURES_WITH_NO_SUCCESS, MIN_SUCCESSES_FOR_PROMOTION, evaluateProcedureStatus } from "../procedurePolicy.js";

describe("evaluateProcedureStatus", () => {
  it("never promotes to active on a single success", () => {
    // The one rule every other rule in this policy exists to serve: one lucky run must never
    // become an authoritative procedure.
    expect(evaluateProcedureStatus("candidate", 1, 0)).toBe("candidate");
    expect(MIN_SUCCESSES_FOR_PROMOTION).toBeGreaterThan(1);
  });

  it("stays a candidate below the promotion threshold", () => {
    for (let n = 1; n < MIN_SUCCESSES_FOR_PROMOTION; n += 1) {
      expect(evaluateProcedureStatus("candidate", n, 0)).toBe("candidate");
    }
  });

  it("promotes to active once the clean-success threshold is reached", () => {
    expect(evaluateProcedureStatus("candidate", MIN_SUCCESSES_FOR_PROMOTION, 0)).toBe("active");
  });

  it("blocks promotion if any failure has been recorded, however many successes", () => {
    // "Repeated success" means an unbroken record, not a majority - a single recorded failure
    // resets the bar even with an otherwise clean history.
    expect(evaluateProcedureStatus("candidate", MIN_SUCCESSES_FOR_PROMOTION + 5, 1)).toBe("candidate");
  });

  it("rejects a candidate that has only ever failed, once it fails enough", () => {
    expect(evaluateProcedureStatus("candidate", 0, MAX_FAILURES_WITH_NO_SUCCESS)).toBe("rejected");
    expect(evaluateProcedureStatus("candidate", 0, MAX_FAILURES_WITH_NO_SUCCESS - 1)).toBe("candidate");
  });

  it("keeps rejection terminal - no automatic path back to candidacy", () => {
    expect(evaluateProcedureStatus("rejected", 100, 0)).toBe("rejected");
  });

  it("demotes an active procedure once failures catch up with successes", () => {
    expect(evaluateProcedureStatus("active", 5, 5)).toBe("deprecated");
    expect(evaluateProcedureStatus("active", 5, 1)).toBe("active");
  });

  it("lets a deprecated procedure earn its way back only by clearing the promotion bar again", () => {
    expect(evaluateProcedureStatus("deprecated", MIN_SUCCESSES_FOR_PROMOTION, 0)).toBe("active");
    expect(evaluateProcedureStatus("deprecated", MIN_SUCCESSES_FOR_PROMOTION - 1, 0)).toBe("deprecated");
    expect(evaluateProcedureStatus("deprecated", MIN_SUCCESSES_FOR_PROMOTION, 1)).toBe("deprecated");
  });
});
