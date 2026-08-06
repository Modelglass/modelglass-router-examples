#!/usr/bin/env node
/**
 * shot-prompt-refiner — LLM-in-the-loop prompt refinement for video shots
 * planned by shot-plan-compiler (SCO-357).
 *
 * Takes a storyboard + the plan shot-plan-compiler computed for it (the
 * `{ storyboard, plan }` JSON `shot-plan-compiler`'s `plan.ts --json` emits),
 * pulls each picked model's live capability profile via the Modelglass MCP
 * endpoint, and has an LLM rewrite each shot's rough prompt to fit the model
 * actually assigned to it — citing the exact capability field behind every
 * change, same house style as av-prompt-refiner/image-prompt-refiner.
 *
 * The one thing those two tools don't do: which LLM performs the rewrite is
 * itself routed off the live Modelglass LLM feed (cheap/fast for a single
 * shot, stronger reasoning for a multi-shot storyboard needing cross-shot
 * consistency) instead of a hardcoded model — see lib.ts's
 * selectRefinerModel.
 *
 * This DOES make a real LLM call (unlike shot-plan-compiler, which is
 * planner-only). It never calls a video-generation provider — it only
 * outputs refined prompts. See README.md for the cost/latency trade-off
 * this adds, and why it's opt-in rather than a default step.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  type StoryboardPlan,
  type ShotWithPick,
  complexityFor,
  fetchModelProfile,
  fetchLLMModels,
  formatGroundingContext,
  joinStoryboardAndPlan,
  selectRefinerModel,
  requireApiKey,
  hr,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Demo data — the real worked-example picks from shot-plan-compiler's own
// README (product-teaser storyboard, run against the live feed 2026-07-12),
// so --demo here doesn't require actually running shot-plan-compiler first,
// while still using a genuine, previously-observed plan rather than an
// invented one.
// ---------------------------------------------------------------------------

const DEMO: StoryboardPlan = {
  storyboard: {
    title: "Product teaser — 3 shots",
    shots: [
      {
        id: "shot-1",
        description: "Wide establishing shot of the product on a table, slow push-in",
        durationSeconds: 5,
        resolution: "1080p",
        fps: 24,
        audio: false,
      },
      {
        id: "shot-2",
        description: "Continuation: camera continues past the product into a close-up detail",
        durationSeconds: 12,
        resolution: "1080p",
        fps: 24,
        audio: false,
        continuityFromPrevious: true,
      },
      {
        id: "shot-3",
        description: "Final hero shot with voiceover tagline",
        durationSeconds: 6,
        resolution: "1080p",
        fps: 30,
        audio: true,
      },
    ],
  },
  plan: {
    storyboard_title: "Product teaser — 3 shots",
    selections: [
      { shot_id: "shot-1", picked: { model_id: "wan-video/wan-2-5", name: "Wan 2.5", provider: "fal" } },
      { shot_id: "shot-2", picked: { model_id: "runway/act-two", name: "Act Two", provider: "runway" } },
      { shot_id: "shot-3", picked: { model_id: "openai/sora-2", name: "Sora 2", provider: "openai" } },
    ],
  },
};

// ---------------------------------------------------------------------------
// Prompt construction — one combined call across every shot being refined,
// not one call per shot. Cross-shot consistency (the reason a multi-shot
// storyboard is "complex") is only reasoned about correctly in a single
// pass that sees every shot at once — the same principle as
// av-prompt-refiner's combined video+audio mode, applied across N shots
// instead of two modalities.
// ---------------------------------------------------------------------------

function buildSystemPrompt(pairs: ShotWithPick[], groundingByModelId: Map<string, string>): string {
  const shared = `You are a prompt engineer specializing in generative video prompts. You are given a storyboard's shots, each with a rough prompt and structured capability data pulled live from the Modelglass registry for the video model already chosen for that shot.

Rules:
- Ground every change in the capability data provided for that shot's model. Do not invent capabilities, parameters, or limitations that aren't stated in the data.
- If a shot's rough prompt asks for something its model's data says it can't do well, adapt the prompt to fit and note the tradeoff — don't silently drop the request or ignore the constraint.
- Match each model's own prompting conventions where its data describes them.
- For every shot, end with a "What changed and why" line naming the specific capability-data field that drove each change.`;

  const multiShot =
    pairs.length > 1
      ? `\n\nThis storyboard has ${pairs.length} shots that will be viewed in sequence. Reason about all of them AT ONCE, not as independent rewrites:
- Keep mood/tone/genre/subject language consistent across shots so they read as one piece, not unrelated clips.
- A shot marked "continuity from previous" is a frame-conditioned continuation of the shot before it — its refined prompt should describe what continues or changes from that prior shot, not restate an unrelated scene.
- Add a "Consistency notes" section (once, covering the whole storyboard) calling out concrete continuity points you enforced across shots.`
      : "";

  const shotBlocks = pairs
    .map(({ shot, picked }, i) => {
      const grounding = groundingByModelId.get(picked.model_id) ?? "(no capability data)";
      return `#### Shot ${i + 1}: ${shot.id}${shot.continuityFromPrevious ? " (continuity from previous)" : ""}
Rough prompt: ${shot.description}
Assigned model: ${picked.name} (${picked.model_id})

${grounding}`;
    })
    .join("\n\n---\n\n");

  const outputFormat = pairs
    .map((p, i) => `## Shot ${i + 1} (${p.shot.id}) — Refined Prompt\n...\n\n## Shot ${i + 1} (${p.shot.id}) — What Changed and Why\n...`)
    .join("\n\n")
    .concat(pairs.length > 1 ? "\n\n## Consistency Notes\n..." : "");

  return `${shared}${multiShot}\n\nOutput format:\n\n${outputFormat}\n\n---\n\nShots:\n\n${shotBlocks}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      "Usage:",
      "  npm run refine-shots -- <storyboard-plan.json>",
      "  npm run refine-shots -- --demo",
      "",
      "  <storyboard-plan.json> is the { storyboard, plan } JSON shot-plan-compiler's",
      "  plan.ts emits with --json:",
      "    npm run plan -- my-storyboard.json --json > plan.json",
      "    npm run refine-shots -- plan.json",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));

  let input: StoryboardPlan;
  if (args.includes("--demo")) {
    input = DEMO;
  } else if (positional.length === 1) {
    const file = positional[0]!;
    try {
      input = JSON.parse(readFileSync(file, "utf8")) as StoryboardPlan;
    } catch (e) {
      printUsageAndExit(`failed to read '${file}': ${e instanceof Error ? e.message : e}`);
    }
  } else {
    printUsageAndExit();
  }

  if (!input.storyboard?.shots?.length) {
    printUsageAndExit("input has no storyboard.shots — is this a shot-plan-compiler --json plan?");
  }
  if (!input.plan?.selections) {
    printUsageAndExit(
      "input has no plan.selections. If this came from 'plan.ts --alternates --json', re-run " +
        "without --alternates — shot-prompt-refiner needs one concrete plan.",
    );
  }

  const { pairs, skipped } = joinStoryboardAndPlan(input.storyboard, input.plan);

  console.error(hr());
  console.error("  shot-prompt-refiner");
  console.error(hr());
  console.error(`  Storyboard: ${input.storyboard.title}`);
  console.error(`  ${pairs.length} shot(s) to refine, ${skipped.length} skipped.\n`);
  for (const s of skipped) {
    console.error(`  ⚠ skipping ${s.shot_id}: ${s.reason}`);
  }
  if (pairs.length === 0) {
    console.error("\nNo shots with a picked model to refine. Nothing to do.");
    process.exit(1);
  }

  const modelglassKey = requireApiKey("MODELGLASS_API_KEY");
  const anthropicKey = requireApiKey("ANTHROPIC_API_KEY");

  // ---- Ground each distinct picked video model -----------------------
  console.error(`\nFetching capability profiles for ${new Set(pairs.map((p) => p.picked.model_id)).size} model(s) ...`);
  const groundingByModelId = new Map<string, string>();
  for (const modelId of new Set(pairs.map((p) => p.picked.model_id))) {
    const profile = await fetchModelProfile(modelglassKey, modelId);
    groundingByModelId.set(modelId, formatGroundingContext(profile));
  }

  // ---- Route the refiner LLM itself off the live LLM feed ------------
  const complexity = complexityFor(pairs.length);
  console.error(`\nRouting refiner LLM (complexity: ${complexity}, ${pairs.length} shot(s)) ...`);
  const llmModels = await fetchLLMModels(modelglassKey);
  const routing = selectRefinerModel(llmModels, complexity);
  if (!routing.selected) {
    console.error(
      `\nNo qualifying Anthropic-hosted model clears the '${routing.minReasoningRating}' reasoning bar ` +
        `for ${complexity} refinement. Excluded candidates:`,
    );
    for (const ex of routing.excluded) {
      console.error(`  ✗ ${ex.model.name} (${ex.model.model_id}): ${ex.reason}`);
    }
    process.exit(1);
  }
  console.error(
    `  Selected: ${routing.selected.name} (${routing.selected.model_id}) — ` +
      `reasoning: ${routing.selected.reasoningRating}, $${routing.selected.inputPricePerM}/1M input tokens; ` +
      `cheapest of ${routing.qualifying.length} qualifying Anthropic-hosted candidate(s) clearing the ` +
      `'${routing.minReasoningRating}' reasoning bar.`,
  );

  // The Anthropic SDK model id is the registry model_id's suffix after
  // "anthropic/" — same convention av-prompt-refiner/image-prompt-refiner's
  // hardcoded "claude-opus-4-8" already relies on.
  const anthropicModelId = routing.selected.model_id.replace(/^anthropic\//, "");

  const system = buildSystemPrompt(pairs, groundingByModelId);
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  console.error(`\nRefining ${pairs.length} shot prompt(s) with ${anthropicModelId} ...\n`);
  console.error(hr());
  console.error("");

  const stream = anthropic.messages.stream({
    model: anthropicModelId,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: "Refine the shot prompts above per the output format." }],
  });

  stream.on("text", (delta) => process.stdout.write(delta));
  await stream.finalMessage();
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
