// Searches the repo's index for existing functions that look like the PR's new code.
// Claude decides later whether it's real duplication; this only filters plausible candidates.
import { findSimilarCode } from "../_shared/code-index.ts";
import { chunkCode } from "../_shared/code-chunk.ts";
import { addedBlocks, changedOldRanges } from "./diff.ts";

const MIN_BLOCK_LINES = 3; // shorter blocks carry no signal
const MIN_SIMILARITY = 0.8;
const PER_BLOCK = 3;
const MAX_CANDIDATES = 6;

export interface ExistingCode {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  similarity: number;
}

export async function findExistingCode(repo: string, files: { path: string; patch: string }[]): Promise<ExistingCode[]> {
  // Each added block is split by function, like the index: in a new file, a small function would be
  // diluted inside the whole file's embedding and wouldn't look like anything.
  const blocks = files.flatMap((file) => {
    const changed = changedOldRanges(file.patch);
    return addedBlocks(file.patch)
      .flatMap((b) => chunkCode(b.text).map((c) => c.content))
      .filter((text) => text.split("\n").filter((l) => l.trim()).length >= MIN_BLOCK_LINES)
      .map((text) => ({ file, block: { text }, changed }));
  });
  if (blocks.length === 0) return [];

  // A single embeddings batch for all of the PR's blocks
  const matchesPerBlock = await findSimilarCode(repo, blocks.map((b) => `${b.file.path}\n${b.block.text}`), PER_BLOCK);

  const best = new Map<number, ExistingCode>();
  blocks.forEach(({ file, changed }, i) => {
    for (const match of matchesPerBlock[i]) {
      if (match.similarity < MIN_SIMILARITY) continue;
      // The previous version of the code this PR changes isn't "code that already exists"
      const overlapsChange = match.path === file.path &&
        changed.some(([from, to]) => match.start_line <= to && match.end_line >= from);
      if (overlapsChange) continue;
      const prev = best.get(match.id);
      if (!prev || match.similarity > prev.similarity) {
        best.set(match.id, {
          path: match.path,
          symbol: match.symbol,
          startLine: match.start_line,
          endLine: match.end_line,
          content: match.content,
          similarity: match.similarity,
        });
      }
    }
  });
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, MAX_CANDIDATES);
}
