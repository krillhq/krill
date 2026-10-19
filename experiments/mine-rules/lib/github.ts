// Downloads GitHub data with the `gh` CLI (already authenticated), with a local cache in data/.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  diff_hunk: string;
  html_url: string;
  pull_request_url: string;
  created_at: string;
  in_reply_to_id?: number;
  original_commit_id?: string; // the commit the reviewer was looking at when commenting
  user: { login: string; type: string };
}

export interface InstructionFile {
  path: string;
  content: string;
}

// Files where teams write their rules for people and for AI agents
const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
];
const INSTRUCTION_DIRS = [".cursor/rules"];
const MAX_PAGES = 10; // 100 comments per page

export function gh(path: string, raw = false): string {
  const args = ["api", path];
  if (raw) args.push("-H", "Accept: application/vnd.github.raw");
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function tryGh(path: string, raw = false): string | null {
  try {
    return gh(path, raw);
  } catch {
    return null; // 404: the file doesn't exist
  }
}

export function dataDir(repo: string): string {
  const dir = `data/${repo.replace("/", "__")}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fetchComments(repo: string, maxPages = MAX_PAGES): ReviewComment[] {
  const dir = dataDir(repo);
  let pages = fs.readdirSync(dir).filter((f) => /^page-\d+\.json$/.test(f));

  if (pages.length === 0) {
    for (let page = 1; page <= maxPages; page++) {
      const json = gh(
        `repos/${repo}/pulls/comments?sort=created&direction=desc&per_page=100&page=${page}`,
      );
      if (json.trim() === "[]") break;
      fs.writeFileSync(`${dir}/page-${page}.json`, json);
    }
    pages = fs.readdirSync(dir).filter((f) => /^page-\d+\.json$/.test(f));
  }

  return pages.flatMap((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")) as ReviewComment[]);
}

export function fetchInstructionFiles(repo: string): InstructionFile[] {
  const cache = `${dataDir(repo)}/instruction-files.json`;
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));

  const files: InstructionFile[] = [];
  for (const path of INSTRUCTION_FILES) {
    const content = tryGh(`repos/${repo}/contents/${path}`, true);
    if (content) files.push({ path, content });
  }
  for (const dir of INSTRUCTION_DIRS) {
    const listing = tryGh(`repos/${repo}/contents/${dir}`);
    if (!listing) continue;
    for (const entry of JSON.parse(listing) as { path: string; type: string }[]) {
      if (entry.type !== "file") continue;
      const content = tryGh(`repos/${repo}/contents/${entry.path}`, true);
      if (content) files.push({ path: entry.path, content });
    }
  }

  fs.writeFileSync(cache, JSON.stringify(files, null, 2));
  return files;
}
