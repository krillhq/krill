// Entry point of the Krill Lab GitHub App webhook.
// Verifies the signature, filters events and responds in <1s; the heavy work runs in the background.
import "@supabase/functions-js/edge-runtime.d.ts";
import { verify } from "@octokit/webhooks-methods";
import type {
  InstallationEvent,
  InstallationRepositoriesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PushEvent,
} from "@octokit/webhooks-types";
import { handleReviewComment } from "./learn.ts";
import { db } from "../_shared/db.ts";
import { githubApp } from "../_shared/github.ts";
import { onboardRepository } from "../_shared/onboarding.ts";
import { reviewPullRequest } from "./review.ts";
import { handlePush, isDefaultBranchPush } from "./push.ts";

const WEBHOOK_SECRET = Deno.env.get("GITHUB_WEBHOOK_SECRET")!;
const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // 1. Verify the HMAC signature over the raw body, before parsing anything
  const body = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  if (!(await verify(WEBHOOK_SECRET, body, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");
  console.log(`[${deliveryId}] event ${event}`);
  const inBackground = (label: string, work: Promise<unknown>) => {
    EdgeRuntime.waitUntil(work.catch((err) => console.error(`[${deliveryId}] ${label} failed`, err)));
    return new Response("Accepted", { status: 202 });
  };

  switch (event) {
    case "ping":
      return new Response("pong");

    case "installation":
      return handleInstallation(JSON.parse(body) as InstallationEvent, inBackground);

    case "installation_repositories": {
      const payload = JSON.parse(body) as InstallationRepositoriesEvent;
      if (payload.action !== "added") return new Response("Ignored action", { status: 200 });
      return inBackground("onboarding", onboardAll(payload.installation.id, payload.repositories_added));
    }

    case "pull_request_review_comment": {
      const payload = JSON.parse(body) as PullRequestReviewCommentEvent;
      if (payload.action !== "created") return new Response("Ignored action", { status: 200 });
      return inBackground("learning", handleReviewComment(payload));
    }

    case "push": {
      const payload = JSON.parse(body) as PushEvent;
      if (!isDefaultBranchPush(payload)) return new Response("Ignored push", { status: 200 });
      return inBackground("push", handlePush(payload));
    }

    case "pull_request": {
      // Only new PRs or PRs with new commits; never drafts or the PRs Krill Lab opens
      const payload = JSON.parse(body) as PullRequestEvent;
      const { draft, head } = payload.pull_request;
      if (!REVIEWABLE_ACTIONS.has(payload.action) || draft || head.ref.startsWith("krill/")) {
        return new Response("Ignored action", { status: 200 });
      }
      return inBackground("review", reviewPullRequest(payload));
    }

    default:
      return new Response("Ignored event", { status: 200 });
  }
});

// Customer install and uninstall. On install, each repo is analyzed to propose its rules.
async function handleInstallation(
  payload: InstallationEvent,
  inBackground: (label: string, work: Promise<unknown>) => Response,
): Promise<Response> {
  const { id, account } = payload.installation;
  if (payload.action === "created") {
    const { error } = await db.from("installations").upsert({ id, account_login: account.login });
    if (error) throw error;
    return inBackground("onboarding", onboardAll(id, payload.repositories ?? []));
  }
  if (payload.action === "deleted") {
    const { error } = await db.from("installations").delete().eq("id", id);
    if (error) throw error;
  }
  return new Response("ok");
}

// One at a time: each analysis makes several calls to Claude and GitHub
async function onboardAll(installationId: number, repositories: { full_name: string }[]) {
  const octokit = await githubApp.getInstallationOctokit(installationId);
  for (const { full_name } of repositories) {
    const [owner, repo] = full_name.split("/");
    try {
      const outcome = await onboardRepository(octokit, installationId, owner, repo);
      console.log(`[onboarding] ${full_name}: ${outcome}`);
    } catch (err) {
      console.error(`[onboarding] ${full_name} failed`, err);
    }
  }
}
