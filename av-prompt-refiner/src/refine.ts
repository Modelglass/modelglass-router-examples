#!/usr/bin/env node
/**
 * AV Prompt Refiner — capability-aware prompt rewriting for video/audio generation.
 *
 * Given a rough prompt and one or two already-chosen models (video and/or audio),
 * pulls each model's capability profile from the live Modelglass MCP endpoint and
 * has Claude rewrite the prompt to fit that model specifically — its prompt
 * conventions, supported parameters, and known limitations. In combined mode,
 * reasons across both profiles at once to produce a coordinated pair of prompts
 * plus explicit sync notes, rather than two independent rewrites bolted together.
 *
 * See README.md for setup, flags, and worked examples.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  fetchModelProfile,
  formatGroundingContext,
  requireApiKey,
  type Mode,
} from "./lib.js";

interface ParsedArgs {
  mode: Mode;
  videoModelId?: string;
  audioModelId?: string;
  prompt: string;
}

function printUsageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      "Usage:",
      "  npm run refine -- --mode video --video-model <model_id> --prompt \"<rough prompt>\"",
      "  npm run refine -- --mode audio --audio-model <model_id> --prompt \"<rough prompt>\"",
      "  npm run refine -- --mode both  --video-model <model_id> --audio-model <model_id> --prompt \"<rough prompt>\"",
      "",
      "  <model_id> is the Modelglass cross-host id, e.g. klingai/kling-2-1 or stability-ai/stable-audio-3-0.",
      "  Find ids via GET /v1/models?modality=video|audio on the live feed, or the modelglass_list_models MCP tool.",
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
  if (!mode || !["video", "audio", "both"].includes(mode)) {
    printUsageAndExit("--mode must be one of: video, audio, both");
  }
  if (!flags.prompt) printUsageAndExit("--prompt is required");
  if ((mode === "video" || mode === "both") && !flags["video-model"]) {
    printUsageAndExit("--video-model is required for mode=video and mode=both");
  }
  if ((mode === "audio" || mode === "both") && !flags["audio-model"]) {
    printUsageAndExit("--audio-model is required for mode=audio and mode=both");
  }

  return {
    mode,
    videoModelId: flags["video-model"],
    audioModelId: flags["audio-model"],
    prompt: flags.prompt,
  };
}

function buildSystemPrompt(mode: Mode, groundingBlocks: string[]): string {
  const shared = `You are a prompt engineer specializing in generative video and audio prompts. You are given a rough, plain-language prompt and structured capability data pulled live from the Modelglass registry for one or two AI generation models the caller has already chosen.

Rules:
- Ground every change in the capability data provided below. Do not invent capabilities, parameters, or limitations that aren't stated in the data.
- If the rough prompt asks for something a model's data says it can't do well (e.g. a duration past its clip-duration ceiling, a feature its limitations rule out), adapt the prompt to fit and note the tradeoff — don't silently drop the request or silently ignore the constraint.
- Match the model's own prompting conventions where the data describes them (e.g. "responds to cinematic camera terminology" means write camera direction as prose, not as an API parameter).
- Always end with a "What changed and why" section: one line per change, each naming the specific capability-data field that drove it (e.g. "Trimmed to 10s — kling-2-1's clip-duration-ceiling caps at 10s per call").`;

  const combinedInstructions =
    mode === "both"
      ? `\n\nThis is COMBINED mode: the video and audio outputs are for the same creative piece and must work together. Reason about both capability profiles AT ONCE, not as two independent rewrites:
- Match duration and pacing between the two prompts using whichever model's data gives you a concrete constraint (e.g. the video model's clip-duration-ceiling should bound the audio's target length).
- Align mood/tone/genre language across both prompts so they describe the same piece.
- Add an explicit "Consistency notes" section with concrete sync points (e.g. "audio swell at 0:05 matches the video's camera push-in"), grounded in whatever timing/conditioning capabilities the data actually mentions (e.g. an audio model with seconds-start/seconds-total timing conditioning can be pointed at a specific instant; one without that feature can only be given prose pacing guidance — say which case applies).

Output format:
## Refined Video Prompt
...
## Refined Audio Prompt
...
## Consistency Notes
...
## What Changed and Why
...`
      : `\n\nOutput format:
## Refined ${mode === "video" ? "Video" : "Audio"} Prompt
...
## What Changed and Why
...`;

  return `${shared}${combinedInstructions}\n\n---\n\nCapability data:\n\n${groundingBlocks.join("\n\n")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modelglassKey = requireApiKey("MODELGLASS_API_KEY");
  const anthropicKey = requireApiKey("ANTHROPIC_API_KEY");
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const groundingBlocks: string[] = [];
  if (args.videoModelId) {
    console.error(`Fetching capability profile: ${args.videoModelId} ...`);
    const profile = await fetchModelProfile(modelglassKey, args.videoModelId);
    groundingBlocks.push(formatGroundingContext(profile, "video"));
  }
  if (args.audioModelId) {
    console.error(`Fetching capability profile: ${args.audioModelId} ...`);
    const profile = await fetchModelProfile(modelglassKey, args.audioModelId);
    groundingBlocks.push(formatGroundingContext(profile, "audio"));
  }

  const system = buildSystemPrompt(args.mode, groundingBlocks);

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
