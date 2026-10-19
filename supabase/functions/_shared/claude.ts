// Shared Claude client: structured output validated with Zod, plus usage logging.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// KRILL_MODEL switches models without code changes (e.g. Haiku for cheaper tests)
const MODEL = Deno.env.get("KRILL_MODEL") || "claude-opus-5-5";

// Only these models support automatic fallback to another model when a classifier declines the request
const SUPPORTS_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export async function ask<T extends z.ZodType>(
  step: string,
  system: string,
  content: string,
  schema: T,
): Promise<z.infer<T>> {
  const fallback = SUPPORTS_FALLBACK.has(MODEL)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...fallback,
    system,
    output_config: { effort: "high", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });

  console.log(
    `[${step}] model=${response.model} stop=${response.stop_reason} ` +
      `in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  );

  if (response.stop_reason === "refusal") {
    throw new Error(`[${step}] Claude declined the request (${response.stop_details?.category ?? "no category"})`);
  }
  if (!response.parsed_output) {
    throw new Error(`[${step}] response without valid JSON (stop_reason=${response.stop_reason})`);
  }
  return response.parsed_output;
}
