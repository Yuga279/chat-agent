import { describe, expect, it } from "vitest";
import {
  ALL_SUBTYPES,
  MEMORY_KINDS,
  SUBTYPES_BY_KIND,
  allowedScopesFor,
  assertValidTaxonomy,
  expiresAtFor,
  isScopeAllowed,
  isSubtypeOfKind,
  kindForSubtype,
  resolveLegacyKind,
  ttlDaysFor,
} from "../taxonomy.js";

describe("memory taxonomy", () => {
  it("assigns every subtype to exactly one kind", () => {
    for (const subtype of ALL_SUBTYPES) {
      const owningKinds = MEMORY_KINDS.filter((kind) => SUBTYPES_BY_KIND[kind].includes(subtype));
      expect(owningKinds, `subtype "${subtype}" must belong to exactly one kind`).toHaveLength(1);
      expect(kindForSubtype(subtype)).toBe(owningKinds[0]);
    }
  });

  it("classifies factual memory as a semantic subtype, not its own kind", () => {
    expect(kindForSubtype("fact")).toBe("semantic");
    expect(kindForSubtype("preference")).toBe("semantic");
    expect(isSubtypeOfKind("semantic", "fact")).toBe(true);
    expect(isSubtypeOfKind("episodic", "fact")).toBe(false);
  });

  it("keeps episodic and procedural memory as distinct kinds", () => {
    expect(kindForSubtype("episode")).toBe("episodic");
    expect(kindForSubtype("procedure")).toBe("procedural");
  });
});

describe("legacy kind migration", () => {
  it("maps each pre-taxonomy kind onto its kind/subtype pair", () => {
    expect(resolveLegacyKind("fact")).toEqual({ kind: "semantic", subtype: "fact" });
    expect(resolveLegacyKind("preference")).toEqual({ kind: "semantic", subtype: "preference" });
    expect(resolveLegacyKind("episode")).toEqual({ kind: "episodic", subtype: "episode" });
  });

  it("falls back to semantic/fact for an unrecognised legacy value", () => {
    // A row written by some future/unknown code path must still migrate to something valid
    // rather than producing an item that fails taxonomy validation forever.
    expect(resolveLegacyKind("something-else")).toEqual({ kind: "semantic", subtype: "fact" });
  });
});

describe("lifecycle policy", () => {
  it("never auto-expires semantic memory", () => {
    // A timezone or preference stops being true when it *changes*, which consolidation handles.
    // Ageing it out on a timer would silently lose a still-correct fact.
    for (const subtype of SUBTYPES_BY_KIND.semantic) {
      expect(ttlDaysFor(subtype), `${subtype} must not carry a TTL`).toBeNull();
      expect(expiresAtFor(subtype)).toBeNull();
    }
  });

  it("never auto-expires procedures", () => {
    expect(ttlDaysFor("procedure")).toBeNull();
    expect(expiresAtFor("procedure")).toBeNull();
  });

  it("expires episodes after their TTL, measured from the write instant", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const expiry = expiresAtFor("episode", from);

    expect(expiry).not.toBeNull();
    const days = (expiry!.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(ttlDaysFor("episode"));
  });
});

describe("scope policy", () => {
  it("allows semantic and episodic memory at user and workspace scope", () => {
    for (const kind of ["semantic", "episodic"] as const) {
      expect(isScopeAllowed(kind, "user")).toBe(true);
      expect(isScopeAllowed(kind, "workspace")).toBe(true);
    }
  });

  it("confines procedural memory to workspace scope", () => {
    // A procedure is a shared asset, not a personal preference - a user-scoped procedure would be
    // invisible to everyone else in the workspace it describes.
    expect(allowedScopesFor("procedural")).toEqual(["workspace"]);
    expect(isScopeAllowed("procedural", "user")).toBe(false);
  });

  it("rejects a subtype that does not belong to its kind", () => {
    expect(() => assertValidTaxonomy("episodic", "fact", "user")).toThrow(/does not belong to kind/);
  });

  it("rejects a kind written at a disallowed scope", () => {
    expect(() => assertValidTaxonomy("procedural", "procedure", "user")).toThrow(/may not be written at scope/);
  });

  it("accepts every valid kind/subtype/scope combination", () => {
    for (const kind of MEMORY_KINDS) {
      for (const subtype of SUBTYPES_BY_KIND[kind]) {
        for (const scope of allowedScopesFor(kind)) {
          expect(() => assertValidTaxonomy(kind, subtype, scope)).not.toThrow();
        }
      }
    }
  });
});
