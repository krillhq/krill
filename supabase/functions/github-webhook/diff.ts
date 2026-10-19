// Numbers a patch's lines for the LLM and works out which lines GitHub allows comments on.
// GitHub rejects comments on lines outside the diff, and the LLM tends to invent them.

export interface AnnotatedPatch {
  text: string; // diff with line numbers, for the LLM
  commentableLines: Set<number>; // lines (right side) GitHub allows comments on
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function annotatePatch(patch: string): AnnotatedPatch {
  const out: string[] = [];
  const commentableLines = new Set<number>();
  let line = 0;

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      line = Number(hunk[1]);
      out.push(raw);
    } else if (raw.startsWith("-")) {
      out.push(`     ${raw}`); // only exists in the old version
    } else if (raw.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else {
      commentableLines.add(line); // added (+) or context line
      out.push(`${String(line).padStart(4)} ${raw}`);
      line++;
    }
  }
  return { text: out.join("\n"), commentableLines };
}

export interface AddedBlock {
  startLine: number; // new side, 1-based
  endLine: number;
  text: string;
}

// Contiguous runs of added lines: the new code compared against the rest of the repo
export function addedBlocks(patch: string): AddedBlock[] {
  const blocks: AddedBlock[] = [];
  let line = 0;
  let current: { start: number; lines: string[] } | null = null;
  const close = () => {
    if (current) blocks.push({ startLine: current.start, endLine: current.start + current.lines.length - 1, text: current.lines.join("\n") });
    current = null;
  };

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      close();
      line = Number(hunk[1]);
    } else if (raw.startsWith("+")) {
      current ??= { start: line, lines: [] };
      current.lines.push(raw.slice(1));
      line++;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      continue; // they don't advance the new side's numbering
    } else {
      close();
      line++;
    }
  }
  close();
  return blocks;
}

const OLD_START = /^@@ -(\d+)/;

// Lines of the previous version that the PR deletes or replaces: that old code doesn't count as "already exists".
// The hunk's context lines aren't touched, so they're still valid existing code.
export function changedOldRanges(patch: string): [number, number][] {
  const ranges: [number, number][] = [];
  let old = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(OLD_START);
    if (hunk) {
      old = Number(hunk[1]);
    } else if (raw.startsWith("-")) {
      const last = ranges.at(-1);
      if (last && last[1] === old - 1) last[1] = old;
      else ranges.push([old, old]);
      old++;
    } else if (!raw.startsWith("+") && !raw.startsWith("\\")) {
      old++; // context
    }
  }
  return ranges;
}
