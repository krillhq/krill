// Ways to call the model with structured output. Each user brings their own: an Anthropic API key,
// a Claude Code subscription, or a local model with Ollama (free).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Ask } from "../../supabase/functions/_shared/mining-core.ts";

export type ProviderName = "anthropic" | "claude-code" | "ollama";

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-haiku-5-5",
  "claude-code": "haiku",
  ollama: "qwen2.5:14b",
};

export const usage = { input: 0, output: 0 };

// Claude Code validates the schema as draft-7: it rejects the 2020-12 "$schema" Zod adds by default
function jsonSchema(schema: z.ZodType) {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: "draft-7" });
  return rest;
}

export function createAsk(provider: ProviderName, model: string): Ask {
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("--provider anthropic needs ANTHROPIC_API_KEY. Get one at https://console.anthropic.com");
    return anthropicAsk(model);
  }
  if (provider === "claude-code") return claudeCodeAsk(model);
  return ollamaAsk(model);
}

// ── Anthropic API (ANTHROPIC_API_KEY) ────────────────────────────────────────

// Only these models support automatic fallback to another model when a classifier declines the request
const SUPPORTS_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

function anthropicAsk(model: string): Ask {
  return async (step, system, content, schema) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { betaZodOutputFormat } = await import("@anthropic-ai/sdk/helpers/beta/zod");
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const fallback = SUPPORTS_FALLBACK.has(model)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {};
    // Streaming: mining hundreds of comments produces long responses
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000,
      ...fallback,
      system,
      output_config: { effort: "high", format: betaZodOutputFormat(schema) },
      messages: [{ role: "user", content }],
    });
    const message = await stream.finalMessage();
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    if (message.stop_reason !== "end_turn") throw new Error(`[${step}] no result (stop_reason=${message.stop_reason})`);
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return schema.parse(JSON.parse(text));
  };
}

// ── Claude Code (`claude -p`, uses the user's subscription) ──────────────────

// Claude Code may be on the PATH, in the native installer's folder, or only inside an editor extension
export function findClaude(): string | null {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [process.env.KRILL_CLAUDE_BIN, "claude", path.join(homedir(), ".local", "bin", exe), path.join(homedir(), ".claude", "local", exe)];
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const dir = path.join(homedir(), editor, "extensions");
    const extensions = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith("anthropic.claude-code-")) : [];
    // Newest version first
    for (const ext of extensions.sort().reverse()) candidates.push(path.join(dir, ext, "resources", "native-binary", exe));
  }
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 15_000 });
      return bin;
    } catch {
      // not here: try the next one
    }
  }
  return null;
}

function claudeCodeAsk(model: string): Ask {
  const bin = findClaude() ?? "claude";
  return async (step, system, content, schema) => {
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(jsonSchema(schema)),
      "--system-prompt", system,
      "--tools", "", // reason over the text only: no reading files or running anything
      "--no-session-persistence",
      "--model", model,
    ];
    const stdout = await run(bin, args, content);
    const out = JSON.parse(stdout) as {
      is_error?: boolean;
      result?: string;
      structured_output?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    if (out.is_error || out.structured_output === undefined) {
      throw new Error(`[${step}] Claude Code returned no structured output: ${out.result ?? stdout.slice(0, 300)}`);
    }
    // Claude Code sends most of the input through the prompt cache: add up all three parts
    const u = out.usage ?? {};
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    usage.input += input;
    usage.output += u.output_tokens ?? 0;
    return schema.parse(out.structured_output);
  };
}

// The prompt goes through stdin (it can be hundreds of KB) and runs outside the user's repo
function run(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "EINVAL") {
        reject(new Error(`Could not run "${bin}". Install Claude Code, or set KRILL_CLAUDE_BIN to the full path of the claude executable.`));
      } else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited with code ${code}: ${stderr.trim() || stdout.slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}

// ── Ollama (modelo local, gratis) ────────────────────────────────────────────

const OLLAMA_CONTEXT = 32_768;

function ollamaAsk(model: string): Ask {
  const host = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
  return async (step, system, content, schema) => {
    let response: Response;
    try {
      response = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: jsonSchema(schema),
          options: { num_ctx: OLLAMA_CONTEXT, temperature: 0 },
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        }),
      });
    } catch {
      throw new Error(`Could not reach Ollama at ${host}. Is it running? (https://ollama.com)`);
    }
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as { message: { content: string }; prompt_eval_count?: number; eval_count?: number };
    usage.input += data.prompt_eval_count ?? 0;
    usage.output += data.eval_count ?? 0;
    return schema.parse(JSON.parse(data.message.content));
  };
}
