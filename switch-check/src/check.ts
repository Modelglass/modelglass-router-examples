/**
 * switch-check — grounded model-migration diff (CLI core)
 *
 * Usage:
 *   MODELGLASS_API_KEY=<key> node --import tsx/esm src/check.ts --from <model_id> --to <model_id>
 *   MODELGLASS_API_KEY=<key> node --import tsx/esm src/check.ts --from <model_id>
 *
 * With --from alone, candidate to-models come from the feed's own
 * GET /v1/models/:modelId/competitors list and each resolvable candidate gets
 * the full diff.
 *
 * Works on every plan tier. The price-stability section is computed from
 * whatever slice of the append-only pricing[] history the caller's plan
 * window exposes (ADR 0004), and says so — on Free, it states in-context
 * exactly what Starter/Pro would add to this specific run.
 *
 * Evidence, not a verdict: this prints what the feed can prove about the
 * migration, with every claim citing its data field. It does not recommend.
 *
 * See Linear SCO-193 for the full spec.
 */

import {
  type ModelEntry,
  type KeyRecord,
  type CapabilityChange,
  fetchAllModels,
  fetchCompetitors,
  fetchTier,
  requireApiKey,
  comparePrices,
  analyzeModelHistory,
  historyWindowLabel,
  capabilityDiff,
  unitWarnings,
  lifecycleCheck,
  fmtPrice,
  fmtPct,
  hr,
  MODELGLASS_API,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  from: string;
  to: string | null;
}

function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let to: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") from = argv[++i] ?? null;
    else if (argv[i] === "--to") to = argv[++i] ?? null;
    else if (argv[i] === "--help" || argv[i] === "-h") usage(0);
    else usage(1, `Unknown argument '${argv[i]}'`);
  }
  if (!from) usage(1, "--from <model_id> is required");
  if (to && to === from) usage(1, "--from and --to are the same model — nothing to diff");
  return { from: from!, to };
}

function usage(code: number, message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    "switch-check — grounded model-migration diff\n\n" +
      "  --from <model_id>           the model you're on (e.g. bfl/flux-1-1-pro)\n" +
      "  --to <model_id>             the model you're considering (optional — omit to\n" +
      "                              diff against the feed's own competitor list)\n\n" +
      "  MODELGLASS_API_KEY must be set (any plan tier — free keys work; see the\n" +
      "  price-stability section's window note for what paid tiers add).",
  );
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function resolveModel(models: ModelEntry[], id: string, flag: string): ModelEntry {
  const exact = models.find((m) => m.model_id === id);
  if (exact) return exact;
  const near = models
    .filter(
      (m) =>
        m.model_id.toLowerCase().includes(id.toLowerCase()) ||
        m.name.toLowerCase().includes(id.toLowerCase()),
    )
    .slice(0, 5);
  console.error(`Error: ${flag} '${id}' not found in the feed.`);
  if (near.length) {
    console.error(`Did you mean:\n${near.map((m) => `  ${m.model_id}  (${m.name})`).join("\n")}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function twelveMonthsAgo(today: Date): string {
  const d = new Date(today);
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}

/** The in-context window framing for the stability section. On Free/App this
 *  is the upgrade hook: it names, for THIS run's two models, exactly what
 *  Starter and Pro would add. It never claims hidden entries exist — a
 *  gated key cannot know that — only what a wider window would show if the
 *  history holds any. */
function windowFraming(tier: KeyRecord["tier"], fromModel: ModelEntry, toModel: ModelEntry): string[] {
  const today = new Date();
  const names = `${fromModel.name} and ${toModel.name}`;
  if (tier === "free" || tier === "app") {
    const windowDesc = tier === "free" ? "≈2-day Free window" : "90-day App window";
    return [
      `  This key's ${windowDesc} shows each price's current entry only (unless it changed`,
      `  within the window). The current entry keeps its real effective_from — so the price AGES`,
      `  above are honest — but anything a price changed FROM is outside the window.`,
      ``,
      `  On this exact run, Starter (12-month window) would show every price change since`,
      `  ${twelveMonthsAgo(today)} for ${names} (if any) — including whether either`,
      `  current price is a recent cut or a long-standing rate. Pro removes the window entirely:`,
      `  the full append-only history, every entry with effective_from + source provenance.`,
      `  Upgrade: https://modelglass.com.au/signup — fields unlocked: tiers.pricing[] (earlier entries)`,
    ];
  }
  if (tier === "starter") {
    return [
      `  This key's 12-month Starter window covers changes since ${twelveMonthsAgo(today)}.`,
      `  Anything older is out of view — Pro removes the window (full append-only history).`,
    ];
  }
  return []; // pro/internal — the numbers above are the full history; nothing to caveat.
}

function printDiff(
  fromModel: ModelEntry,
  toModel: ModelEntry,
  tier: KeyRecord["tier"],
): void {
  const today = new Date();
  console.log("\n" + hr());
  console.log(`  switch-check — ${fromModel.model_id} → ${toModel.model_id}`);
  console.log(`  (${fromModel.name} → ${toModel.name})`);
  console.log(hr());

  // -- Section 1: price delta + stability --------------------------------
  const prices = comparePrices(fromModel, toModel);

  console.log(`\n  1. PRICE — current, unit-matched (fields: tiers.pricing[].amount, .unit)`);
  if (!prices.shared.length) {
    console.log(
      `  No billing unit is priced on BOTH sides — no honest same-unit delta exists.` +
        `\n  See section 3 for what each side prices in and how the cost curve differs.`,
    );
  }
  for (const cmp of prices.shared) {
    console.log(
      `  ${cmp.unit}: ${fmtPrice(cmp.from.amount, cmp.from.unit)} (${cmp.from.provider}) → ` +
        `${fmtPrice(cmp.to.amount, cmp.to.unit)} (${cmp.to.provider})  ${fmtPct(cmp.delta_pct)}` +
        (cmp.delta_pct < 0 ? " cheaper" : cmp.delta_pct > 0 ? " dearer" : " (no change)"),
    );
  }

  console.log(`\n  PRICE STABILITY — window: ${historyWindowLabel(tier)}`);
  console.log(`  (fields: tiers.pricing[].effective_from, .effective_to, .source.url)`);
  for (const { label, model } of [
    { label: "from", model: fromModel },
    { label: "to  ", model: toModel },
  ]) {
    console.log(`  [${label}] ${model.name}:`);
    for (const h of analyzeModelHistory(model, today)) {
      const cur = h.current;
      let line =
        `    ${h.provider}/${h.tier_id}: ${fmtPrice(cur.amount, cur.unit)} since ` +
        `${cur.effective_from} (${cur.age_days} days)`;
      if (h.previous) {
        const p = h.previous;
        line +=
          ` — ${p.direction.toUpperCase()} from ${fmtPrice(p.amount, cur.unit)} (${fmtPct(p.delta_pct)})`;
      } else {
        line += ` — no earlier entry in window`;
      }
      if (cur.source_url) line += ` — source: ${cur.source_url}`;
      console.log(line);
    }
  }
  const framing = windowFraming(tier, fromModel, toModel);
  if (framing.length) {
    console.log("");
    for (const line of framing) console.log(line);
  }

  // -- Section 2: capability diff ----------------------------------------
  const caps = capabilityDiff(fromModel, toModel);
  console.log(`\n  2. CAPABILITY DIFF (fields: knowledge.capability_profile[].dimension, .rating)`);
  if (!caps.length) {
    console.log(
      `  Neither model has a capability_profile in the registry — nothing to compare.` +
        `\n  (join_status: ${fromModel.join_status ?? "unknown"} / ${toModel.join_status ?? "unknown"})`,
    );
  }
  const byKind = (kind: CapabilityChange["kind"]) => caps.filter((c) => c.kind === kind);
  for (const c of byKind("lose")) {
    console.log(`  LOSE  ${c.dimension}: ${c.from} → ${c.to}`);
  }
  for (const c of byKind("gain")) {
    console.log(`  GAIN  ${c.dimension}: ${c.from} → ${c.to}`);
  }
  for (const c of byKind("unverifiable")) {
    const missing = c.from === null ? fromModel.name : toModel.name;
    console.log(
      `  ?     ${c.dimension}: ${c.from ?? "(no rating)"} → ${c.to ?? "(no rating)"} — ` +
        `${missing} has no rating for this dimension; cannot verify, not assumed`,
    );
  }
  const same = byKind("same");
  if (same.length) {
    console.log(`  same  ${same.map((c) => `${c.dimension}: ${c.to}`).join("; ")}`);
  }

  // -- Section 3: billing units ------------------------------------------
  const warnings = unitWarnings(prices);
  console.log(`\n  3. BILLING UNITS (fields: tiers.pricing[].unit)`);
  if (!warnings.length) {
    const units = [...new Set(prices.shared.map((c) => c.unit))].join(", ");
    console.log(
      `  No cost-curve change: every unit priced on one side is also priced on the other` +
        (units ? ` (${units})` : "") +
        `. Deltas in section 1 are all same-unit.`,
    );
  }
  for (const w of warnings) {
    const label = w.from_unit === w.to_unit ? w.from_unit : `${w.from_unit} → ${w.to_unit}`;
    console.log(`  ⚠ ${label}: ${w.note}`);
  }

  // -- Section 4: lifecycle ----------------------------------------------
  const flags = lifecycleCheck(fromModel, toModel);
  console.log(`\n  4. LIFECYCLE (fields: model.status, model.generation)`);
  if (!flags.length) {
    console.log(`  Both directions clear: every offering on both sides is status=ga, generation=current.`);
  }
  for (const f of flags) {
    console.log(`  ${f.severity === "warn" ? "⚠" : "ℹ"} [${f.side}] ${f.model_id}: ${f.note}`);
  }

  console.log("\n" + hr());
  console.log(
    `  Evidence, not a verdict — every line above cites the feed field it came from;` +
      `\n  whether to migrate stays your call.`,
  );
  console.log(hr() + "\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const args = parseArgs(process.argv.slice(2));

  console.log(`Fetching feed from ${MODELGLASS_API} ...`);
  const [tier, models] = await Promise.all([fetchTier(apiKey), fetchAllModels(apiKey)]);
  console.log(`Plan tier (via GET /v1/keys): ${tier}`);

  const fromModel = resolveModel(models, args.from, "--from");

  if (args.to) {
    const toModel = resolveModel(models, args.to, "--to");
    printDiff(fromModel, toModel, tier);
    return;
  }

  // --from alone: candidates come from the feed's own competitor list.
  console.log(`No --to given — pulling candidates from GET /v1/models/:modelId/competitors ...`);
  const competitors = await fetchCompetitors(apiKey, fromModel.model_id);
  if (!competitors.length) {
    console.log(
      `The feed lists no competitors for ${fromModel.model_id} ` +
        `(closest_competitors is empty for every offering) — nothing to diff against.\n` +
        `Pass --to <model_id> to diff against a model of your choice.`,
    );
    return;
  }

  const skipReason = (c: (typeof competitors)[number]): string | null => {
    if (c.model_id === fromModel.model_id) return "same model (a different host, not a migration)";
    if (!c.model_id || !models.some((m) => m.model_id === c.model_id))
      return "no resolvable model_id in the feed";
    return null;
  };
  const resolvable = competitors.filter((c) => skipReason(c) === null);
  const skipped = competitors.filter((c) => skipReason(c) !== null);

  console.log(
    `Feed lists ${competitors.length} competitor(s); running the full diff for ` +
      `${resolvable.length} that resolve to a distinct model in the feed.`,
  );
  if (skipped.length) {
    console.log(
      `Skipped (listed, not silently dropped):` +
        `\n${skipped
          .map(
            (c) =>
              `  · ${c.model_name ?? c.slug} — ${skipReason(c)}${c.notes ? ` — feed notes: ${c.notes}` : ""}`,
          )
          .join("\n")}`,
    );
  }

  for (const comp of resolvable) {
    const toModel = models.find((m) => m.model_id === comp.model_id)!;
    printDiff(fromModel, toModel, tier);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
