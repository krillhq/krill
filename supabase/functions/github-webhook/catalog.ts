// Helper catalog: the function signatures of the repo's shared modules.
// Embeddings group code by topic (stock, orders…), not by what it does; with the signatures,
// Claude recognizes when new code reimplements an existing helper even under a different name.
import { db } from "../_shared/db.ts";

const SHARED_MODULE_SQL = "(^|/)(lib|libs|utils?|helpers?|shared|common|hooks|services?|core)/";
const COMMENT = /^\s*(#|\/\/|\/?\*)/;
const MAX_ENTRIES = 400;
const MAX_CHARS = 16_000;
const MAX_SIGNATURE = 160;

export async function loadHelperCatalog(repo: string): Promise<string> {
  // The filter lives in SQL: filtering after a LIMIT left out the modules at the end of the ordering
  const { data, error } = await db
    .from("code_chunks")
    .select("path, symbol, start_line, content")
    .eq("repo", repo)
    .not("symbol", "is", null)
    .filter("path", "imatch", SHARED_MODULE_SQL)
    .order("path")
    .order("start_line")
    .limit(MAX_ENTRIES);
  if (error) throw error;

  const lines: string[] = [];
  let chars = 0;
  for (const chunk of data) {
    const entry = describe(chunk.path, chunk.start_line, chunk.content);
    if (!entry || chars + entry.length > MAX_CHARS || lines.length >= MAX_ENTRIES) continue;
    lines.push(entry);
    chars += entry.length;
  }
  return lines.join("\n");
}

// "path:line signature  // preceding comment", without the function body
function describe(path: string, startLine: number, content: string): string | null {
  const rows = content.split("\n");
  const signatureIndex = rows.findIndex((r) => r.trim() && !COMMENT.test(r) && !r.trim().startsWith("@"));
  if (signatureIndex < 0) return null;
  const signature = rows[signatureIndex].trim().replace(/\s*\{$/, "").slice(0, MAX_SIGNATURE);
  const comment = rows
    .slice(0, signatureIndex)
    .map((r) => r.replace(/^\s*(#|\/\/|\/\*\*?|\*\/?)\s?/, "").trim())
    .filter(Boolean)
    .at(-1);
  return `${path}:${startLine + signatureIndex} ${signature}${comment ? `  // ${comment.slice(0, 100)}` : ""}`;
}
