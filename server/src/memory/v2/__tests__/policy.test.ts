import { describe, expect, it } from "vitest";
import { MemoryPolicy } from "../policy.js";

describe("MemoryPolicy", () => {
  const policy = new MemoryPolicy();

  it("classifies a plain preference as non-sensitive", () => {
    const sensitivity = policy.classify({
      subject: "user",
      predicate: "prefers_currency",
      object: "INR",
      content: "user prefers_currency: INR",
    });
    expect(sensitivity).toBe("none");
  });

  it("classifies a card-number-shaped value as sensitive", () => {
    const sensitivity = policy.classify({
      subject: "user",
      predicate: "payment_card",
      object: "4111 1111 1111 1111",
      content: "user payment_card: 4111 1111 1111 1111",
    });
    expect(sensitivity).toBe("sensitive");
  });

  it("classifies a health-topic keyword as sensitive", () => {
    const sensitivity = policy.classify({
      subject: "user",
      predicate: "has_condition",
      object: "recently diagnosed with something",
      content: "user has_condition: recently received a diagnosis",
    });
    expect(sensitivity).toBe("sensitive");
  });

  it("blocks auto-capture for sensitive candidates regardless of confidence", () => {
    expect(policy.canAutoCapture("sensitive", 0.99)).toBe(false);
  });

  it("blocks auto-capture for low-confidence non-sensitive candidates", () => {
    expect(policy.canAutoCapture("none", 0.4)).toBe(false);
  });

  it("allows auto-capture for confident, non-sensitive candidates", () => {
    expect(policy.canAutoCapture("none", 0.9)).toBe(true);
  });
});
