// Index of the default branch's code in pgvector, built in batches by the "index-worker" function.
// Planning (diffing the repo tree against the index) is cheap; each batch is processed in a separate
// worker run, so no single Edge Function hits its CPU and time limits.
import type { Octokit } from "octokit";
import { db } from "./db.ts";
import { embedMany } from "./embeddings.ts";
import { chunkCode, CODE_FILE, SKIPPED_PATH } from "./code-chunk.ts";

const MAX_FILES = 1000; // per-repo cap in the MVP
const MAX_FILE_BYTES = 100_000;
const MAX_EMBED_CHARS = 6000;
export const FILES_PER_BATCH = 25;

export async function hasCodeIndex(repo: string): Promise<boolean> {
  const { count, error } = await db.from("code_files").select("path", { count: "exact", head: true }).eq("repo", repo);
  if (error) throw error;
  return (count ?? 0) > 0;
}

// Marks new or changed files as pending and deletes the ones that no longer exist
export async function planIndex(
  octokit: Octokit,
  installationId: number,
  owner: string,
  repo: string,
): Promise<number> {
  const fullName = `${owner}/${repo}`;
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: repoData.default_branch,
    recursive: "true",
  });
  const blobs = tree.tree
    .filter((e) => e.type === "blob" && e.path && e.sha && isIndexable(e.path, e.size))
    .slice(0, MAX_FILES) as { path: string; sha: string }[];

  const { data: known, error } = await db.from("code_files").select("path, blob_sha").eq("repo", fullName);
  if (error) throw error;
  const knownSha = new Map(known.map((f) => [f.path, f.blob_sha]));

  const pending = blobs
    .filter((b) => knownSha.get(b.path) !== b.sha)
    .map((b) => ({ repo: fullName, path: b.path, installation_id: installationId, blob_sha: b.sha, status: "pending" }));
  if (pending.length > 0) {
    const { error: upsertError } = await db.from("code_files").upsert(pending, { onConflict: "repo,path" });
    if (upsertError) throw upsertError;
  }

  const present = new Set(blobs.map((b) => b.path));
  const gone = known.map((f) => f.path).filter((p) => !present.has(p));
  if (gone.length > 0) {
    const { error: deleteError } = await db.from("code_files").delete().eq("repo", fullName).in("path", gone);
    if (deleteError) throw deleteError;
  }
  return pending.length;
}

// After a push: touched files become pending and are read from the default branch when processed
export async function markPaths(installationId: number, repo: string, changed: string[], removed: string[]) {
  const gone = removed.filter((p) => CODE_FILE.test(p));
  if (gone.length > 0) {
    const { error } = await db.from("code_files").delete().eq("repo", repo).in("path", gone);
    if (error) throw error;
  }
  const pending = changed
    .filter((p) => isIndexable(p))
    .map((path) => ({ repo, path, installation_id: installationId, blob_sha: null, status: "pending" }));
  if (pending.length > 0) {
    const { error } = await db.from("code_files").upsert(pending, { onConflict: "repo,path" });
    if (error) throw error;
  }
  return pending.length;
}

// Processes one batch: reads the files, chunks them and stores their embeddings. Returns how many remain.
export async function processBatch(
  getOctokit: (installationId: number) => Promise<Octokit>,
  repo: string,
): Promise<{ processed: number; remaining: number }> {
  const { data: claimed, error } = await db.rpc("claim_code_files", { p_repo: repo, p_limit: FILES_PER_BATCH });
  if (error) throw error;
  const files = claimed as { path: string; installation_id: number; blob_sha: string | null }[];
  if (files.length === 0) return { processed: 0, remaining: 0 };

  try {
    return await indexFiles(getOctokit, repo, files);
  } catch (err) {
    // A failed batch puts its files back in the queue right away, for the next attempt
    await db.from("code_files").update({ status: "pending", claimed_at: null }).eq("repo", repo).in(
      "path",
      files.map((f) => f.path),
    ).eq("status", "processing");
    throw err;
  }
}

async function indexFiles(
  getOctokit: (installationId: number) => Promise<Octokit>,
  repo: string,
  files: { path: string; installation_id: number; blob_sha: string | null }[],
): Promise<{ processed: number; remaining: number }> {
  const [owner, name] = repo.split("/");
  const octokit = await getOctokit(files[0].installation_id);
  const rows: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const done: { path: string; sha: string | null }[] = [];

  for (const file of files) {
    const source = await readFile(octokit, owner, name, file.path, file.blob_sha);
    if (source === null) {
      await db.from("code_files").delete().eq("repo", repo).eq("path", file.path); // no longer exists
      continue;
    }
    for (const chunk of chunkCode(source.content)) {
      rows.push({
        repo,
        path: file.path,
        symbol: chunk.symbol,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        content: chunk.content,
      });
      texts.push(`${file.path}\n${chunk.content}`.slice(0, MAX_EMBED_CHARS));
    }
    done.push({ path: file.path, sha: source.sha });
  }

  // One round of Voyage calls for the whole batch
  const embeddings = await embedMany(texts, null);
  rows.forEach((row, i) => (row.embedding = embeddings[i]));

  const paths = done.map((d) => d.path);
  const { error: deleteError } = await db.from("code_chunks").delete().eq("repo", repo).in("path", paths);
  if (deleteError) throw deleteError;
  if (rows.length > 0) {
    const { error: insertError } = await db.from("code_chunks").insert(rows);
    if (insertError) throw insertError;
  }
  for (const d of done) {
    const { error: updateError } = await db
      .from("code_files")
      .update({ status: "done", blob_sha: d.sha, indexed_at: new Date().toISOString() })
      .eq("repo", repo)
      .eq("path", d.path);
    if (updateError) throw updateError;
  }

  const { count, error: countError } = await db
    .from("code_files")
    .select("path", { count: "exact", head: true })
    .eq("repo", repo)
    .neq("status", "done");
  if (countError) throw countError;
  return { processed: done.length, remaining: count ?? 0 };
}

async function readFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  blobSha: string | null,
): Promise<{ content: string; sha: string } | null> {
  try {
    if (blobSha) {
      const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: blobSha });
      return { content: decodeBase64(data.content), sha: blobSha };
    }
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if (Array.isArray(data) || data.type !== "file") return null;
    return { content: decodeBase64(data.content), sha: data.sha };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

// Asks the worker to process a repo's index. Each call is a fresh run with its own limits.
export async function kickIndexWorker(repo: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/index-worker?repo=${encodeURIComponent(repo)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`index-worker responded ${response.status}`);
}

function isIndexable(path: string, size?: number): boolean {
  return CODE_FILE.test(path) && !SKIPPED_PATH.test(path) && (size === undefined || size <= MAX_FILE_BYTES);
}

function decodeBase64(content: string): string {
  const bytes = Uint8Array.from(atob(content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function findSimilarCode(repo: string, queries: string[], count: number) {
  const embeddings = await embedMany(queries.map((q) => q.slice(0, MAX_EMBED_CHARS)), null);
  const results = [];
  for (const embedding of embeddings) {
    const { data, error } = await db.rpc("match_code_chunks", {
      p_repo: repo,
      p_query_embedding: embedding,
      p_match_count: count,
    });
    if (error) throw error;
    results.push(
      data as {
        id: number;
        path: string;
        symbol: string | null;
        start_line: number;
        end_line: number;
        content: string;
        similarity: number;
      }[],
    );
  }
  return results;
}
