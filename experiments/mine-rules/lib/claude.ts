// Claude client shared by the pipeline steps, with cost accounting.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

// Keys come from the environment or supabase/.env. KRILL_MODEL picks the model; Haiku by default
// so test runs cost cents.
const ENV_FILE = new URL("../../../supabase/.env", import.meta.url);
const ENV = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
export const MODEL = envValue("KRILL_MODEL") ?? "claude-haiku-5-5";

// USD per million tokens (input, output). Haiku 5.5 costs more above 100K prompt tokens.
const PRICING: Record<string, (input: number) => [number, number]> = {
  "claude-opus-5-5": () => [4, 20],
  "claude-sonnet-5-5": () => [2, 10],
  "claude-haiku-5-5": (input) => (input > 100_000 ? [0.5, 2.5] : [0.1, 0.5]),
};
const SUPPORTS_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export const usage = { input: 0, output: 0, usd: 0 };

export function envValue(name: string): string | undefined {
  return process.env[name] || ENV.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() || undefined;
}

const apiKey = envValue("ANTHROPIC_API_KEY");
if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (in the environment or supabase/.env)");
const client = new Anthropic({ apiKey });

export async function ask<T extends z.ZodType>(
  step: string,
  system: string,
  content: string,
  schema: T,
): Promise<z.infer<T>> {
  const started = Date.now();
  const fallback = SUPPORTS_FALLBACK.has(MODEL)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
  // Streaming: allows long responses (mining hundreds of comments) without timeouts
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    ...fallback,
    system,
    output_config: { effort: "high", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = message.stop_reason === "end_turn" ? schema.safeParse(JSON.parse(text)) : null;
  const response = { ...message, parsed_output: parsed?.success ? (parsed.data as z.infer<T>) : null };

  const { input_tokens, output_tokens } = response.usage;
  const [priceIn, priceOut] = (PRICING[MODEL] ?? PRICING["claude-opus-5-5"])(input_tokens);
  const usd = (input_tokens * priceIn + output_tokens * priceOut) / 1e6;
  usage.input += input_tokens;
  usage.output += output_tokens;
  usage.usd += usd;
  console.log(
    `[${step}] ${response.model} stop=${response.stop_reason} in=${input_tokens} out=${output_tokens} ` +
      `≈ $${usd.toFixed(3)} en ${Math.round((Date.now() - started) / 1000)}s`,
  );

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`[${step}] no result (stop_reason=${response.stop_reason})`);
  }
  return response.parsed_output;
}
