// Internal tool: manually loads (or replaces) a rules document for a repo.
// Normally the customer keeps .krill/rules.md in their repo; this is for pilots and tests.
//
// POST /functions/v1/ingest-rules?repo=<owner>/<repo>&title=<optional title>[&scope=org]
// Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
// Body: the document in Markdown (text/markdown)
import "@supabase/functions-js/edge-runtime.d.ts";
import { githubApp } from "../_shared/github.ts";
import { db } from "../_shared/db.ts";
import { saveRuleDocument } from "../_shared/rules-store.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("authorization") !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const [owner, repo] = (url.searchParams.get("repo") ?? "").split("/");
  const title = url.searchParams.get("title") ?? "Architecture rules";
  const orgWide = url.searchParams.get("scope") === "org";
  const content = await req.text();
  if (!owner || !repo) return Response.json({ error: "Missing ?repo=<owner>/<repo>" }, { status: 400 });
  if (!content.trim()) return Response.json({ error: "The document is empty" }, { status: 400 });

  let installationId: number;
  try {
    const { data } = await githubApp.octokit.rest.apps.getRepoInstallation({ owner, repo });
    installationId = data.id;
  } catch {
    return Response.json({ error: `The App isn't installed on ${owner}/${repo}` }, { status: 404 });
  }

  const { error } = await db.from("installations").upsert({ id: installationId, account_login: owner });
  if (error) throw error;

  const scope = orgWide ? null : `${owner}/${repo}`;
  const doc = await saveRuleDocument({ installationId, repo: scope, title, content, source: "manual" });

  return Response.json({ installation_id: installationId, repo: scope, document_id: doc.id, title, chunks: doc.chunks });
});
