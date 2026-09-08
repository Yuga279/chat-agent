/**
 * A deliberately tiny in-memory stand-in for the Mongo collection surface the memory repository
 * actually uses. It exists so repository logic - version chains, supersession direction, lifecycle
 * transitions, revision rows - can be tested for real, instead of against a fake that
 * reimplements the very logic under test (which is how the supersession-direction defect survived
 * having a passing test).
 *
 * Only the operators the repository genuinely issues are supported. Anything else throws, so an
 * unsupported query fails loudly rather than silently matching nothing.
 */

type Doc = Record<string, any>;

function matchesOperator(value: unknown, operator: string, operand: unknown): boolean {
  switch (operator) {
    case "$ne":
      return value !== operand;
    case "$lt":
      return value != null && (value as any) < (operand as any);
    case "$lte":
      return value != null && (value as any) <= (operand as any);
    case "$gt":
      return value != null && (value as any) > (operand as any);
    case "$gte":
      return value != null && (value as any) >= (operand as any);
    case "$in":
      return Array.isArray(operand) && operand.includes(value as never);
    case "$exists":
      return (value !== undefined) === Boolean(operand);
    default:
      throw new Error(`inMemoryMongo: unsupported query operator "${operator}"`);
  }
}

function matchesField(doc: Doc, field: string, condition: unknown): boolean {
  const value = doc[field];

  if (condition !== null && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
    return Object.entries(condition as Doc).every(([op, operand]) => matchesOperator(value, op, operand));
  }
  // An array field matches when it *contains* the scalar - Mongo's implicit array semantics, which
  // sourceEventIds queries rely on.
  if (Array.isArray(value)) return value.includes(condition as never);
  return value === condition;
}

export function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Doc[]).some((sub) => matches(doc, sub));
    }
    return matchesField(doc, key, condition);
  });
}

function applySet(doc: Doc, set: Doc): void {
  for (const [key, value] of Object.entries(set)) doc[key] = value;
}

/** Exclusion-style projection only (`{ field: 0 }`) - the only shape this repository ever passes.
 * Previously `find()`/`findOne()` silently ignored their projection argument entirely, which meant
 * a test asserting a field was excluded from an API response could pass against the double while
 * the real Mongo query it was standing in for behaved identically - a false negative waiting to
 * happen the first time such a test was actually written (as listItems's embedding exclusion was). */
function applyProjection<T extends Doc>(doc: T, projection?: Record<string, 0 | 1>): T {
  if (!projection) return { ...doc };
  const copy = { ...doc };
  for (const [field, include] of Object.entries(projection)) {
    if (include === 0) delete copy[field];
  }
  return copy;
}

/** Resolves a `$group` field reference (`"$fieldName"`) against a document, or returns a literal
 * value unchanged - mirrors Mongo's own $group expression syntax closely enough for the one
 * pipeline shape this double needs to support (findEligibleGroup's). */
function resolveRef(doc: Doc, ref: unknown): unknown {
  return typeof ref === "string" && ref.startsWith("$") ? doc[ref.slice(1)] : ref;
}

/**
 * Runs the small subset of the aggregation pipeline this repository actually issues:
 * $match / $group (with $sum and $min accumulators) / $sort / $limit / $project (a no-op here,
 * since this double already omits `_id`). Exists so findEligibleGroup's grouping/eligibility logic
 * - the exact kind of subtle bug (a missing tenant filter) this codebase has already shipped once -
 * can be tested against real logic instead of asserted by inspection.
 */
function runAggregation(docs: Doc[], pipeline: Doc[]): Doc[] {
  let result = docs.map((d) => ({ ...d }));

  for (const stage of pipeline) {
    if (stage.$match) {
      result = result.filter((d) => matches(d, stage.$match));
    } else if (stage.$group) {
      const groups = new Map<string, Doc>();
      for (const doc of result) {
        const idSpec = stage.$group._id;
        const idValue =
          idSpec !== null && typeof idSpec === "object"
            ? Object.fromEntries(Object.entries(idSpec).map(([k, ref]) => [k, resolveRef(doc, ref)]))
            : resolveRef(doc, idSpec);
        const key = JSON.stringify(idValue);
        const group = groups.get(key) ?? { _id: idValue };
        for (const [outField, spec] of Object.entries(stage.$group)) {
          if (outField === "_id") continue;
          const [op, ref] = Object.entries(spec as Doc)[0];
          // $min/$max compare across whatever comparable type the field actually holds (Date in
          // every real pipeline here) - `any` is deliberate, mirroring how the real driver's
          // accumulators are untyped at this level too.
          const val = resolveRef(doc, ref) as any;
          if (op === "$sum") group[outField] = (group[outField] ?? 0) + (typeof ref === "number" ? ref : Number(val ?? 0));
          else if (op === "$min") group[outField] = group[outField] === undefined || val < group[outField] ? val : group[outField];
          else if (op === "$max") group[outField] = group[outField] === undefined || val > group[outField] ? val : group[outField];
          else throw new Error(`inMemoryMongo: unsupported $group accumulator "${op}"`);
        }
        groups.set(key, group);
      }
      result = [...groups.values()];
    } else if (stage.$sort) {
      const [[field, dir]] = Object.entries(stage.$sort as Record<string, number>);
      result = [...result].sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        const cmp = av > bv ? 1 : av < bv ? -1 : 0;
        return cmp * dir;
      });
    } else if (stage.$limit !== undefined) {
      result = result.slice(0, stage.$limit);
    } else if (stage.$project) {
      // No-op: this double never stores a Mongo `_id`, so there is nothing to strip.
    } else {
      throw new Error(`inMemoryMongo: unsupported aggregation stage "${Object.keys(stage)[0]}"`);
    }
  }

  return result;
}

export class InMemoryCollection<T extends Doc = Doc> {
  readonly docs: T[] = [];

  async insertOne(doc: T): Promise<{ insertedId: unknown }> {
    // Structured-clone the stored copy so a caller mutating its own object cannot retroactively
    // change what the "database" holds - the real driver serializes on write.
    this.docs.push({ ...doc } as T);
    return { insertedId: (doc as Doc).id };
  }

  async findOne(filter: Doc, options?: { projection?: Record<string, 0 | 1> }): Promise<T | null> {
    const found = this.docs.find((d) => matches(d, filter)) ?? null;
    return found ? (applyProjection(found, options?.projection) as T) : null;
  }

  find(filter: Doc, options?: { projection?: Record<string, 0 | 1> }) {
    let results = this.docs.filter((d) => matches(d, filter));
    const projection = options?.projection;
    const cursor = {
      sort: (spec: Record<string, number>) => {
        const [[field, dir]] = Object.entries(spec);
        results = [...results].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const cmp = av > bv ? 1 : av < bv ? -1 : 0;
          return cmp * dir;
        });
        return cursor;
      },
      limit: (n: number) => {
        results = results.slice(0, n);
        return cursor;
      },
      toArray: async () => results.map((d) => applyProjection(d, projection)),
    };
    return cursor;
  }

  aggregate<R = Doc>(pipeline: Doc[]) {
    const result = runAggregation(this.docs, pipeline) as unknown as R[];
    return { toArray: async () => result };
  }

  async updateOne(filter: Doc, update: Doc): Promise<{ matchedCount: number; modifiedCount: number }> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (!update.$set) throw new Error("inMemoryMongo: updateOne supports only $set");
    applySet(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Doc, update: Doc): Promise<{ matchedCount: number; modifiedCount: number }> {
    const found = this.docs.filter((d) => matches(d, filter));
    if (!update.$set) throw new Error("inMemoryMongo: updateMany supports only $set");
    for (const doc of found) applySet(doc, update.$set);
    return { matchedCount: found.length, modifiedCount: found.length };
  }

  async deleteMany(filter: Doc): Promise<{ deletedCount: number }> {
    let deleted = 0;
    for (let i = this.docs.length - 1; i >= 0; i -= 1) {
      if (matches(this.docs[i], filter)) {
        this.docs.splice(i, 1);
        deleted += 1;
      }
    }
    return { deletedCount: deleted };
  }

  reset(): void {
    this.docs.length = 0;
  }
}
