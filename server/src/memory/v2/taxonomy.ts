import type { MemoryItemScope, MemoryKind, MemorySubtype } from "../types.js";

/**
 * The formal memory taxonomy - the single source of truth for what kinds/subtypes exist, which
 * scopes each kind may occupy, and how long each subtype lives.
 *
 * The shape deliberately separates `kind` (the psychological memory category) from `subtype` (the
 * category member), because the previous flat enum mixed the two: "fact" and "preference" are both
 * *semantic* memory, while "episode" is a different kind entirely. Factual memory is therefore a
 * subtype of semantic memory here, not its own store - one collection, distinguished by metadata,
 * exactly as the target architecture requires.
 *
 *   semantic   -> fact | preference | entity | relationship | stable_context
 *   episodic   -> episode
 *   procedural -> procedure
 */

export const MEMORY_KINDS = ["semantic", "episodic", "procedural"] as const;

export const SEMANTIC_SUBTYPES = ["fact", "preference", "entity", "relationship", "stable_context"] as const;
export const EPISODIC_SUBTYPES = ["episode"] as const;
export const PROCEDURAL_SUBTYPES = ["procedure"] as const;

export const SUBTYPES_BY_KIND: Record<MemoryKind, readonly MemorySubtype[]> = {
  semantic: SEMANTIC_SUBTYPES,
  episodic: EPISODIC_SUBTYPES,
  procedural: PROCEDURAL_SUBTYPES,
};

export const ALL_SUBTYPES: readonly MemorySubtype[] = [
  ...SEMANTIC_SUBTYPES,
  ...EPISODIC_SUBTYPES,
  ...PROCEDURAL_SUBTYPES,
];

/** True when `subtype` is a member of `kind` - the invariant every write must satisfy. */
export function isSubtypeOfKind(kind: MemoryKind, subtype: MemorySubtype): boolean {
  return SUBTYPES_BY_KIND[kind].includes(subtype);
}

/** The one kind a subtype can belong to. Subtype names are unique across kinds by construction. */
export function kindForSubtype(subtype: MemorySubtype): MemoryKind {
  for (const kind of MEMORY_KINDS) {
    if (SUBTYPES_BY_KIND[kind].includes(subtype)) return kind;
  }
  // Unreachable for a well-typed subtype; kept as a real error rather than a silent default so a
  // future subtype added to the union but not to SUBTYPES_BY_KIND fails loudly.
  throw new Error(`Unknown memory subtype: ${subtype}`);
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Pre-taxonomy rows stored a flat `kind` of "preference" | "fact" | "episode". Both the migration
 * script and any read path that encounters an un-migrated row resolve through here, so the mapping
 * lives in exactly one place.
 */
const LEGACY_KIND_MAP: Record<string, { kind: MemoryKind; subtype: MemorySubtype }> = {
  fact: { kind: "semantic", subtype: "fact" },
  preference: { kind: "semantic", subtype: "preference" },
  episode: { kind: "episodic", subtype: "episode" },
};

export function resolveLegacyKind(legacyKind: string): { kind: MemoryKind; subtype: MemorySubtype } {
  return LEGACY_KIND_MAP[legacyKind] ?? { kind: "semantic", subtype: "fact" };
}

// ---------------------------------------------------------------------------
// Lifecycle / freshness
// ---------------------------------------------------------------------------

/**
 * Default lifetime per subtype, in days. `null` means "no automatic expiry" - the memory lives
 * until it is superseded by a newer value under the same canonical key, or explicitly deleted.
 *
 * Null is the deliberate default for everything semantic: a timezone, a preference or a known
 * entity does not become false with age, it becomes false when it *changes*, and consolidation
 * already handles that. Only episodes carry a TTL, because an episode is a record of one past
 * interaction whose usefulness genuinely decays. Procedures never auto-expire - they are governed
 * by validation/review policy instead, so ageing one out silently would be unsafe.
 */
const TTL_DAYS_BY_SUBTYPE: Record<MemorySubtype, number | null> = {
  fact: null,
  preference: null,
  entity: null,
  relationship: null,
  stable_context: null,
  episode: 365,
  procedure: null,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The expiry instant for a newly-written item of this subtype, or null for no automatic expiry. */
export function expiresAtFor(subtype: MemorySubtype, from: Date = new Date()): Date | null {
  const ttlDays = TTL_DAYS_BY_SUBTYPE[subtype];
  return ttlDays === null ? null : new Date(from.getTime() + ttlDays * MS_PER_DAY);
}

export function ttlDaysFor(subtype: MemorySubtype): number | null {
  return TTL_DAYS_BY_SUBTYPE[subtype];
}

// ---------------------------------------------------------------------------
// Scope policy
// ---------------------------------------------------------------------------

/**
 * Which scopes each kind may be written at. The *application* decides scope, never the model -
 * an extraction candidate carries no scope field at all, and the worker derives it from the
 * originating thread's workspace assignment. This table is the enforcement point for that rule.
 *
 * Only "user" and "workspace" exist today. The wider SYSTEM/TENANT/THREAD hierarchy is not
 * represented here on purpose: a tenant-scoped item belongs to no single user, and every retrieval
 * path currently filters by userId, so introducing that scope without also making retrieval
 * user-independent would create rows that can be written and never read. That work belongs with
 * procedural memory, which is the first kind that actually needs a shared scope.
 */
const ALLOWED_SCOPES_BY_KIND: Record<MemoryKind, readonly MemoryItemScope[]> = {
  semantic: ["user", "workspace"],
  episodic: ["user", "workspace"],
  procedural: ["workspace"],
};

export function isScopeAllowed(kind: MemoryKind, scope: MemoryItemScope): boolean {
  return ALLOWED_SCOPES_BY_KIND[kind].includes(scope);
}

export function allowedScopesFor(kind: MemoryKind): readonly MemoryItemScope[] {
  return ALLOWED_SCOPES_BY_KIND[kind];
}

/** Throws on an invalid kind/subtype/scope combination. Called on every durable memory write. */
export function assertValidTaxonomy(kind: MemoryKind, subtype: MemorySubtype, scope: MemoryItemScope): void {
  if (!isSubtypeOfKind(kind, subtype)) {
    throw new Error(`Invalid memory taxonomy: subtype "${subtype}" does not belong to kind "${kind}".`);
  }
  if (!isScopeAllowed(kind, scope)) {
    throw new Error(
      `Invalid memory scope: kind "${kind}" may not be written at scope "${scope}" ` +
        `(allowed: ${ALLOWED_SCOPES_BY_KIND[kind].join(", ")}).`,
    );
  }
}
