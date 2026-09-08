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

  it("classifies an OpenAI-style API key as a secret", () => {
    const sensitivity = policy.classify({
      subject: "user",
      predicate: "openai_key",
      object: "sk-abcdefghijklmnopqrstuvwx1234",
      content: "user openai_key: sk-abcdefghijklmnopqrstuvwx1234",
    });
    expect(sensitivity).toBe("secret");
  });

  it("classifies an AWS access key as a secret", () => {
    const sensitivity = policy.classify({
      subject: "server",
      predicate: "aws_key",
      object: "AKIAABCDEFGHIJKLMNOP",
      content: "server aws_key: AKIAABCDEFGHIJKLMNOP",
    });
    expect(sensitivity).toBe("secret");
  });

  it("classifies a PEM private key block as a secret", () => {
    const sensitivity = policy.classify({
      subject: "server",
      predicate: "tls_key",
      object: "-----BEGIN RSA PRIVATE KEY-----\nMIIB...",
      content: "server tls_key: -----BEGIN RSA PRIVATE KEY-----",
    });
    expect(sensitivity).toBe("secret");
  });

  it("classifies a connection string with embedded credentials as a secret", () => {
    const sensitivity = policy.classify({
      subject: "database",
      predicate: "connection_string",
      object: "postgres://admin:hunter2@db.internal:5432/prod",
      content: "database connection_string: postgres://admin:hunter2@db.internal:5432/prod",
    });
    expect(sensitivity).toBe("secret");
  });

  it("classifies a JWT as a secret", () => {
    const sensitivity = policy.classify({
      subject: "user",
      predicate: "session_token",
      object: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      content: "session token stored",
    });
    expect(sensitivity).toBe("secret");
  });

  it("never auto-captures a secret, regardless of confidence", () => {
    expect(policy.canAutoCapture("secret", 0.99)).toBe(false);
  });

  it("does not classify an ordinary sentence mentioning 'key' as a secret", () => {
    const sensitivity = policy.classify({
      subject: "user",
      predicate: "favorite_instrument",
      object: "piano, plays in the key of C",
      content: "user favorite_instrument: piano, plays in the key of C",
    });
    expect(sensitivity).toBe("none");
  });
});
