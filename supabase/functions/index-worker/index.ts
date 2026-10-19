// Code index worker: processes one batch of a repo's pending files and, if more remain, invokes
// itself again. Each invocation is a fresh run with its own CPU and time limits.
//
// POST /functions/v1/index-worker?repo=<owner>/<repo>
// Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
import "@supabase/functions-js/edge-runtime.d.ts";
import { githubApp } from "../_shared/github.ts";
import { kickIndexWorker, processBatch } from "../_shared/code-index.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("authorization") !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const repo = new URL(req.url).searchParams.get("repo");
  if (!repo?.includes("/")) return Response.json({ error: "Missing ?repo=<owner>/<repo>" }, { status: 400 });

  EdgeRuntime.waitUntil(runBatch(repo));
  return new Response("Accepted", { status: 202 });
});

async function runBatch(repo: string) {
  try {
    const { processed, remaining } = await processBatch((id) => githubApp.getInstallationOctokit(id), repo);
    console.log(`[index] ${repo}: ${processed} files processed, ${remaining} pending`);
    if (processed > 0 && remaining > 0) await kickIndexWorker(repo);
  } catch (err) {
    // Claimed files stay "processing" and are retried once they're considered abandoned (5 min)
    console.error(`[index] ${repo}: the batch failed`, err);
  }
}
