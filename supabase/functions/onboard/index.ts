// Internal tool: starts (or restarts with ?force=1) a repo's rule analysis.
//
// POST /functions/v1/onboard?repo=<owner>/<repo>[&force=1]
// Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
import "@supabase/functions-js/edge-runtime.d.ts";
import { githubApp } from "../_shared/github.ts";
import { db } from "../_shared/db.ts";
import { forgetOnboarding, onboardRepository } from "../_shared/onboarding.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("authorization") !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const [owner, repo] = (url.searchParams.get("repo") ?? "").split("/");
  if (!owner || !repo) return Response.json({ error: "Missing ?repo=<owner>/<repo>" }, { status: 400 });

  let installationId: number;
  try {
    const { data } = await githubApp.octokit.rest.apps.getRepoInstallation({ owner, repo });
    installationId = data.id;
  } catch {
    return Response.json({ error: `The App isn't installed on ${owner}/${repo}` }, { status: 404 });
  }

  const { error } = await db.from("installations").upsert({ id: installationId, account_login: owner });
  if (error) throw error;
  if (url.searchParams.get("force") === "1") await forgetOnboarding(`${owner}/${repo}`);

  // The analysis can outlast the gateway timeout: respond now and keep going in the background
  const octokit = await githubApp.getInstallationOctokit(installationId);
  EdgeRuntime.waitUntil(
    onboardRepository(octokit, installationId, owner, repo)
      .then((outcome) => console.log(`[onboarding] ${owner}/${repo}: ${outcome}`))
      .catch((err) => console.error(`[onboarding] ${owner}/${repo} failed`, err)),
  );
  return Response.json({ repo: `${owner}/${repo}`, status: "started" }, { status: 202 });
});
