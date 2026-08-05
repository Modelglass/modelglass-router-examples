#!/usr/bin/env node
/**
 * Image Prompt Refiner — capability-aware prompt rewriting for image generation.
 *
 * Given a rough prompt and an already-chosen image model, pulls the model's
 * capability profile from the live Modelglass MCP endpoint and has Claude
 * rewrite the prompt to fit that model specifically — its rated strengths,
 * known limitations, and (where the registry's prose says so) its prompting
 * conventions.
 *
 * Two modes, reflecting a real distinction the image ontology itself draws
 * (see e.g. flux-kontext.yaml's routing_guidance): --mode generate is for
 * pure text-to-image models (describe the whole desired image from
 * scratch); --mode edit is for image-editing models (an existing image plus
 * an instruction — describe only the change, not the whole scene). See
 * README.md for setup, flags, and worked examples.
 */
import Anthropic from "@anthropic-ai/sdk";
import { fetchModelProfile, formatGroundingContext, requireApiKey, type Mode } from "./lib.js";

interface ParsedArgs {
  mode: Mode;
  modelId: string;
  prompt: string;
}

function printUsageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      "Usage:",
      '  npm run refine-image -- --mode generate --model <model_id> --prompt "<rough prompt>"',
      '  npm run refine-image -- --mode edit     --model <model_id> --prompt "<rough prompt>"',
      "",
      "  --mode generate  — pure text-to-image models (e.g. bfl/flux-1-1-pro, google/imagen-4)",
      "  --mode edit      — image-editing models that take an existing image + instruction",
      "                     (e.g. bfl/flux-kontext, bytedance/seedream-4-0)",
      "",
      "  <model_id> is the Modelglass cross-host id. Find ids via",
      "  GET /v1/models?modality=image on the live feed, or the modelglass_list_models MCP tool.",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        printUsageAndExit(`--${key} requires a value`);
      }
      flags[key] = value;
      i++;
    }
  }

  const mode = flags.mode as Mode | undefined;
  if (!mode || !["generate", "edit"].includes(mode)) {
    printUsageAndExit("--mode must be one of: generate, edit");
  }
  if (!flags.model) printUsageAndExit("--model is required");
  if (!flags.prompt) printUsageAndExit("--prompt is required");

  return { mode, modelId: flags.model, prompt: flags.prompt };
}

function buildSystemPrompt(mode: Mode, groundingBlock: string): string {
  const shared = `You are a prompt engineer specializing in generative image prompts. You are given a rough, plain-language prompt and structured capability data pulled live from the Modelglass registry for an AI image model the caller has already chosen.

Rules:
- Ground every change in the capability data provided below. Do not invent capabilities, parameters, or limitations that aren't stated in the data.
- The image ontology has no separate structured fields for things like aspect-ratio limits, negative-prompt support, or reference-image conventions the way video/audio entries do for duration or voice cloning — that information, when it exists at all, is written as prose inside routing_guidance, limitations, architecture notes, or capability_profile notes. Read those fields carefully for anything prompt-relevant (resolution ceilings, style tendencies, editing conventions) rather than expecting a dedicated field.
- If the rough prompt asks for something the data suggests this model handles poorly (e.g. small legible text when text-rendering is rated weak, photorealism when the model is rated primarily for stylised/artistic output), adapt the prompt to fit and note the tradeoff — don't silently drop the request or ignore the mismatch.
- Match the model's own prompting conventions where the data describes them.
- Always end with a "What changed and why" section: one line per change, each naming the specific capability-data field (or the specific prose it came from) that drove it.`;

  const modeInstructions =
    mode === "edit"
      ? `\n\nThis is EDIT mode: the model takes an EXISTING image plus a text instruction, not a from-scratch generation. Rewrite the prompt as an edit instruction:
- Describe only what should CHANGE, not the whole scene — assume the starting image already exists and is provided separately.
- Explicitly preserve whatever should stay the same (subject identity, composition, style) unless the rough prompt asks to change it.
- If the capability data mentions multi-reference-image support (e.g. compositing from several reference images) and the rough prompt implies multiple source images, reflect that in the instruction.
- If the rough prompt reads like a from-scratch generation request with no implied starting image, keep the rewrite but flag in "What changed and why" that this model expects an existing image as input, which a from-scratch prompt alone won't provide.

Output format:
## Refined Edit Instruction
...
## What Changed and Why
...`
      : `\n\nThis is GENERATE mode: pure text-to-image, no existing image involved. Describe the complete desired image from scratch, in the level of detail and style the model's data suggests it responds well to.

Output format:
## Refined Prompt
...
## What Changed and Why
...`;

  return `${shared}${modeInstructions}\n\n---\n\nCapability data:\n\n${groundingBlock}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modelglassKey = requireApiKey("MODELGLASS_API_KEY");
  const anthropicKey = requireApiKey("ANTHROPIC_API_KEY");
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  console.error(`Fetching capability profile: ${args.modelId} ...`);
  const profile = await fetchModelProfile(modelglassKey, args.modelId);
  const groundingBlock = formatGroundingContext(profile);

  const system = buildSystemPrompt(args.mode, groundingBlock);

  console.error("Rewriting prompt with Claude Opus 4.8 ...\n");
  const stream = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: `Rough prompt: ${args.prompt}` }],
  });

  stream.on("text", (delta) => process.stdout.write(delta));
  await stream.finalMessage();
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
