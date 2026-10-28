// GENERATED from @modelglass/core's NON_HEADLINE_UNITS (packages/core/src/units.ts)
// by the modelglass repo's scripts/gen-headline-units.mjs. Don't edit by hand:
// change core, regenerate, and open a PR here (SCO-653). The modelglass repo's
// test suite fails if this list and core's ever differ.

/** Pricing units that are real rates but never a model's headline price
 *  (ADR-0015 prompt-cache units, and any later additions in core). */
export const NON_HEADLINE_UNIT_LIST = [
  "per_1m_tokens_cache_read",
  "per_1m_tokens_cache_write",
] as const;

export const NON_HEADLINE_UNITS: ReadonlySet<string> = new Set(NON_HEADLINE_UNIT_LIST);
