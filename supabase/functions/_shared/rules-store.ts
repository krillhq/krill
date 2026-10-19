// Stores rule documents in pgvector: chunks them, embeds them and replaces the previous version.
import { db } from "./db.ts";
import { embeddingsEnabled, embedMany } from "./embeddings.ts";
import { chunkMarkdown } from "./chunk.ts";

export interface RuleDocument {
  installationId: number;
  repo: string | null; // "owner/name"; null = the whole organization
  title: string;
  content: string;
  source: "manual" | "file";
  path?: string;
  sha?: string;
}

export async function saveRuleDocument(doc: RuleDocument): Promise<{ id: string; chunks: number }> {
  const { data, error } = await db
    .from("rule_documents")
    .upsert(
      {
        installation_id: doc.installationId,
        repo: doc.repo,
        title: doc.title,
        content: doc.content,
        source: doc.source,
        path: doc.path ?? null,
        sha: doc.sha ?? null,
      },
      { onConflict: "installation_id,repo,title" },
    )
    .select("id")
    .single();
  if (error) throw error;

  const { error: deleteError } = await db.from("rule_chunks").delete().eq("document_id", data.id);
  if (deleteError) throw deleteError;

  const chunks = chunkMarkdown(doc.content);
  const embeddings = !embeddingsEnabled ? chunks.map(() => null) : await embedMany(
    chunks.map((c) => (c.heading ? `${c.heading}\n${c.content}` : c.content)),
    "document",
  );
  const rows = chunks.map((chunk, i) => ({
    document_id: data.id,
    installation_id: doc.installationId,
    repo: doc.repo,
    heading: chunk.heading,
    content: chunk.content,
    embedding: embeddings[i],
  }));
  if (rows.length > 0) {
    const { error: insertError } = await db.from("rule_chunks").insert(rows);
    if (insertError) throw insertError;
  }
  return { id: data.id, chunks: rows.length };
}

export async function findFileDocument(installationId: number, repo: string | null, path: string) {
  let query = db
    .from("rule_documents")
    .select("id, sha")
    .eq("installation_id", installationId)
    .eq("source", "file")
    .eq("path", path);
  query = repo === null ? query.is("repo", null) : query.eq("repo", repo);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

export async function deleteRuleDocument(id: string) {
  const { error } = await db.from("rule_documents").delete().eq("id", id);
  if (error) throw error;
}
