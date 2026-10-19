// Splits a Markdown rules document by headings, keeping each section's heading path.

const MAX_CHUNK_CHARS = 1500; // gte-small only sees ~512 tokens per chunk

export interface Chunk {
  heading: string | null; // e.g. "Architecture > Global state"
  content: string;
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headings: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    const heading = headings.filter(Boolean).join(" > ") || null;
    for (const part of splitLong(text)) chunks.push({ heading, content: part });
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const match = !inFence && line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      flush();
      const level = match[1].length;
      headings.length = level - 1;
      headings[level - 1] = match[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return chunks;
}

// Groups paragraphs up to MAX_CHUNK_CHARS without splitting any of them
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}
