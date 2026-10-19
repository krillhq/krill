// Splits source code by top-level declarations (functions, classes…), language-agnostic.
// It's a heuristic: each chunk only needs to be a meaningful unit to compare against new code.

export interface CodeChunk {
  symbol: string | null;
  startLine: number; // 1-based, inclusive
  endLine: number;
  content: string;
}

export const CODE_FILE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|php|cs|rs|swift|scala)$/i;
// Dependencies, generated artifacts and tests aren't the team's "reusable logic"
export const SKIPPED_PATH =
  /(^|\/)(node_modules|vendor|dist|build|out|target|\.next|coverage|__pycache__|migrations?|tests?|__tests__|spec)\/|\.(min|test|spec)\.[a-z]+$|\.d\.ts$/i;

// Modifiers can come in any order: "pub async fn", "async def", "export default async function"…
const DECLARATION =
  /^(?:(?:export|default|async|unsafe|pub(?:\([^)]*\))?|public|private|protected|internal|static|abstract|final|override|open|const(?=\s+fn\b))\s+)*(?:def|class|function\*?|func|fn|interface|struct|enum|trait|impl\b|module|mod\s|object|type\s+\w+\s*=|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function|\w+\s*=>))/;
const SYMBOL =
  /(?:def|class|function\*?|func|fn|interface|struct|enum|trait|impl|module|type|const|let|var)\s+(?:\([^)]*\)\s*)?(?!(?:fn|function|def|class)\b)([A-Za-z_$][\w$]*)/;
const MAX_LINES = 80;
const MIN_LINES = 2; // two-line helpers are exactly the ones that get reimplemented most

export function chunkCode(source: string): CodeChunk[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (DECLARATION.test(line)) starts.push(includeLeadingComments(lines, i));
  });
  if (starts.length === 0 || starts[0] > 0) starts.unshift(0);

  const chunks: CodeChunk[] = [];
  starts.forEach((start, k) => {
    const end = (starts[k + 1] ?? lines.length) - 1;
    for (let from = start; from <= end; from += MAX_LINES) {
      const to = Math.min(end, from + MAX_LINES - 1);
      const body = lines.slice(from, to + 1);
      if (body.filter((l) => l.trim()).length < MIN_LINES) continue;
      chunks.push({
        symbol: body.map((l) => SYMBOL.exec(l)?.[1]).find(Boolean) ?? null,
        startLine: from + 1,
        endLine: to + 1,
        content: body.join("\n").trimEnd(),
      });
    }
  });
  return chunks;
}

// Decorators and comments right above a declaration belong to it
function includeLeadingComments(lines: string[], i: number): number {
  let start = i;
  while (start > 0 && /^\s*(#|\/\/|\/?\*|@)/.test(lines[start - 1])) start--;
  return start;
}
