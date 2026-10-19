// Repo context for the evaluation: an in-memory index of a repo's code at a given date.
// Uses the product's chunker and Voyage embeddings; search is a dot product (Voyage returns
// normalized vectors), so pgvector isn't needed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chunkCode, CODE_FILE, SKIPPED_PATH } from "../../../supabase/functions/_shared/code-chunk.ts";
import { dataDir, gh } from "./github.ts";
import { envValue } from "./claude.ts";

const DIMENSIONS = 1024;
const MAX_FILE_BYTES = 100_000;
const MAX_EMBED_CHARS = 6000;
const BATCH_INPUTS = 128;
const BATCH_CHARS = 240_000;
const SHARED_MODULE = /(^|\/)(lib|libs|utils?|helpers?|shared|common|hooks|services?|core)\//i;

export interface IndexedChunk {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

export interface CodeIndex {
  chunks: IndexedChunk[];
  vectors: Float32Array; // chunks.length × DIMENSIONS
}

// ── Voyage ───────────────────────────────────────────────────────────────────

const VOYAGE_KEY = envValue("VOYAGE_API_KEY");

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (!VOYAGE_KEY) throw new Error("Missing VOYAGE_API_KEY (in the environment or supabase/.env)");
  const out: number[][] = [];
  let batch: string[] = [];
  let chars = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    out.push(...(await voyage(batch)));
    batch = [];
    chars = 0;
  };
  for (const raw of texts) {
    const text = raw.slice(0, MAX_EMBED_CHARS);
    if (batch.length === BATCH_INPUTS || chars + text.length > BATCH_CHARS) await flush();
    batch.push(text);
    chars += text.length;
  }
  await flush();
  return out;
}

async function voyage(input: string[], attempt = 1): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input, model: "voyage-code-3", input_type: null, output_dimension: DIMENSIONS }),
  });
  if (response.ok) {
    const { data } = (await response.json()) as { data: { embedding: number[]; index: number }[] };
    return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    return voyage(input, attempt + 1);
  }
  throw new Error(`Voyage ${response.status}: ${await response.text()}`);
}

// ── Index ────────────────────────────────────────────────────────────────────

// The last commit on the default branch before a date: the code as the team knew it
export function commitAt(repo: string, isoDate: string): string {
  const [commit] = JSON.parse(gh(`repos/${repo}/commits?until=${isoDate}&per_page=1`)) as { sha: string }[];
  return commit.sha;
}

export async function buildIndex(repo: string, sha: string): Promise<CodeIndex> {
  const dir = dataDir(repo);
  const meta = `${dir}/index-${sha}.json`;
  const bin = `${dir}/index-${sha}.bin`;
  if (fs.existsSync(meta) && fs.existsSync(bin)) {
    const raw = fs.readFileSync(bin);
    return {
      chunks: JSON.parse(fs.readFileSync(meta, "utf8")),
      vectors: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
    };
  }

  const root = extractSnapshot(repo, sha);
  const chunks: IndexedChunk[] = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    if (!CODE_FILE.test(rel) || SKIPPED_PATH.test(rel) || fs.statSync(file).size > MAX_FILE_BYTES) continue;
    for (const c of chunkCode(fs.readFileSync(file, "utf8"))) {
      chunks.push({ path: rel, symbol: c.symbol, startLine: c.startLine, endLine: c.endLine, content: c.content });
    }
  }
  console.log(`[index] ${repo}@${sha.slice(0, 7)}: ${chunks.length} chunks from ${new Set(chunks.map((c) => c.path)).size} files`);

  const embeddings = await embedMany(chunks.map((c) => `${c.path}\n${c.content}`));
  const vectors = new Float32Array(chunks.length * DIMENSIONS);
  embeddings.forEach((v, i) => vectors.set(v, i * DIMENSIONS));
  fs.writeFileSync(meta, JSON.stringify(chunks));
  fs.writeFileSync(bin, Buffer.from(vectors.buffer));
  return { chunks, vectors };
}

function extractSnapshot(repo: string, sha: string): string {
  const dir = `${dataDir(repo)}/snapshot-${sha.slice(0, 12)}`;
  if (fs.existsSync(dir)) return path.join(dir, fs.readdirSync(dir)[0]);
  const tarball = `${dataDir(repo)}/snapshot-${sha.slice(0, 12)}.tar.gz`;
  execFileSync("gh", ["api", `repos/${repo}/tarball/${sha}`], {
    stdio: ["ignore", fs.openSync(tarball, "w"), "ignore"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  fs.rmSync(tarball);
  return path.join(dir, fs.readdirSync(dir)[0]); // the tarball has a <owner>-<repo>-<sha> root folder
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// ── Consultas ────────────────────────────────────────────────────────────────

export function nearest(index: CodeIndex, query: number[], k: number): { chunk: IndexedChunk; similarity: number }[] {
  const best: { i: number; s: number }[] = [];
  for (let i = 0; i < index.chunks.length; i++) {
    let s = 0;
    const offset = i * DIMENSIONS;
    for (let d = 0; d < DIMENSIONS; d++) s += index.vectors[offset + d] * query[d];
    if (best.length < k || s > best[best.length - 1].s) {
      best.push({ i, s });
      best.sort((a, b) => b.s - a.s);
      if (best.length > k) best.pop();
    }
  }
  return best.map((b) => ({ chunk: index.chunks[b.i], similarity: b.s }));
}

// Function signatures from the shared modules of the packages the PR touches
export function helperCatalog(index: CodeIndex, touchedPaths: string[], maxChars = 16_000): string {
  const packages = new Set(touchedPaths.map(packageOf));
  const lines: string[] = [];
  let chars = 0;
  for (const c of index.chunks) {
    if (!c.symbol || !SHARED_MODULE.test(c.path) || !packages.has(packageOf(c.path))) continue;
    const entry = describe(c);
    if (!entry || chars + entry.length > maxChars) continue;
    lines.push(entry);
    chars += entry.length;
  }
  return lines.join("\n");
}

// In a monorepo, the package is the first two levels: apps/dotcom, packages/editor…
function packageOf(p: string): string {
  return p.split("/").slice(0, 2).join("/");
}

function describe(c: IndexedChunk): string | null {
  const rows = c.content.split("\n");
  const i = rows.findIndex((r) => r.trim() && !/^\s*(#|\/\/|\/?\*|@)/.test(r));
  if (i < 0) return null;
  return `${c.path}:${c.startLine + i} ${rows[i].trim().replace(/\s*\{$/, "").slice(0, 160)}`;
}
