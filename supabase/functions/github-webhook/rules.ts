// Retrieves the rule chunks most relevant to the diff from pgvector:
// the repo's rules plus the organization-wide ones.
import { db } from "../_shared/db.ts";
import { embeddingsEnabled, embedMany } from "../_shared/embeddings.ts";
import { parseRules, type TeamRule } from "../_shared/rules-format.ts";

// Titles and severity of every applicable rule; repo rules override organization rules
export async function loadTeamRules(installationId: number, repo: string): Promise<TeamRule[]> {
  const { data, error } = await db
    .from("rule_documents")
    .select("repo, content")
    .eq("installation_id", installationId)
    .or(`repo.eq."${repo}",repo.is.null`);
  if (error) throw error;

  const byTitle = new Map<string, TeamRule>();
  const orgFirst = [...data].sort((a, b) => (a.repo === null ? -1 : 0) - (b.repo === null ? -1 : 0));
  for (const doc of orgFirst) {
    for (const rule of parseRules(doc.content)) byTitle.set(rule.title, rule);
  }
  return [...byTitle.values()];
}

const MAX_CHUNKS = 12; // max chunks sent to the LLM
const MAX_CHUNKS_WITHOUT_EMBEDDINGS = 60; // without Voyage there's no search: send all of them up to this cap
const PER_FILE = 4;
const MAX_QUERY_CHARS = 8000;

export interface RuleChunk {
  id: number;
  heading: string | null;
  content: string;
}

export async function retrieveRules(
  installationId: number,
  repo: string,
  files: { path: string; text: string }[],
): Promise<RuleChunk[]> {
  const inScope = `repo.eq."${repo}",repo.is.null`;
  const { count, error: countError } = await db
    .from("rule_chunks")
    .select("id", { count: "exact", head: true })
    .eq("installation_id", installationId)
    .or(inScope);
  if (countError) throw countError;
  if (!count) return [];

  // If there are few rules (or no embeddings), send them all: more context and no risk of missing a rule
  if (count <= MAX_CHUNKS || !embeddingsEnabled) {
    const { data, error } = await db
      .from("rule_chunks")
      .select("id, heading, content")
      .eq("installation_id", installationId)
      .or(inScope)
      .order("id")
      .limit(MAX_CHUNKS_WITHOUT_EMBEDDINGS);
    if (error) throw error;
    return data;
  }

  const queries = await embedMany(
    files.map((f) => `${f.path}\n${f.text}`.slice(0, MAX_QUERY_CHARS)),
    "query",
  );
  const best = new Map<number, RuleChunk & { similarity: number }>();
  for (const [i] of files.entries()) {
    const { data, error } = await db.rpc("match_rule_chunks", {
      p_installation_id: installationId,
      p_repo: repo,
      p_query_embedding: queries[i],
      p_match_count: PER_FILE,
    });
    if (error) throw error;
    for (const chunk of data) {
      const prev = best.get(chunk.id);
      if (!prev || chunk.similarity > prev.similarity) best.set(chunk.id, chunk);
    }
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, MAX_CHUNKS);
}
