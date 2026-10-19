// Authentication as a GitHub App: each customer is an "installation" with its own token.
import { App } from "octokit";

const privateKey = new TextDecoder().decode(
  Uint8Array.from(atob(Deno.env.get("GITHUB_APP_PRIVATE_KEY_B64")!), (c) => c.charCodeAt(0)),
);

export const githubApp = new App({
  appId: Deno.env.get("GITHUB_APP_ID")!,
  privateKey,
});
