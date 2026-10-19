// GitHub data through the `gh` CLI, which already carries the user's authentication: no tokens to set up.
// Calls are async so the spinner keeps moving while downloading.
import { execFile } from "node:child_process";
import { GUIDELINE_FILES, type GuidelineFile, type ReviewComment } from "../../supabase/functions/_shared/mining-core.ts";

const PER_PAGE = 100;

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return reject(new Error("GitHub CLI (gh) not found. Install it from https://cli.github.com and run `gh auth login`."));
      }
      if (/auth login|not logged/i.test(stderr)) {
        return reject(new Error("GitHub CLI is not logged in. Run `gh auth login` and try again."));
      }
      reject(new Error(`gh ${args.join(" ")} failed: ${stderr.trim() || e.message}`));
    });
  });
}

// The current directory's repo, so the CLI can run without arguments inside a checkout
export async function currentRepo(): Promise<string> {
  try {
    return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim();
  } catch (err) {
    if ((err as Error).message.includes("GitHub CLI (gh)")) throw err;
    throw new Error("This folder is not a GitHub repo. Run krill-rules inside a checkout, or pass one: npx krill-rules owner/repo");
  }
}

// The most recent review comments, up to `max`; `onPage` reports progress
export async function fetchReviewComments(
  repo: string,
  max: number,
  onPage: (count: number) => void = () => {},
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];
  for (let page = 1; comments.length < max; page++) {
    const batch = JSON.parse(
      await gh(["api", `repos/${repo}/pulls/comments?sort=created&direction=desc&per_page=${PER_PAGE}&page=${page}`]),
    ) as ReviewComment[];
    comments.push(...batch);
    onPage(Math.min(comments.length, max));
    if (batch.length < PER_PAGE) break;
  }
  return comments.slice(0, max);
}

export async function fetchGuidelines(repo: string): Promise<GuidelineFile[]> {
  const found = await Promise.all(
    GUIDELINE_FILES.map((path) =>
      gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}`])
        .then((content) => ({ path, content }))
        .catch(() => null), // 404: the repo doesn't have that file
    ),
  );
  return found.filter((d): d is GuidelineFile => d !== null);
}
