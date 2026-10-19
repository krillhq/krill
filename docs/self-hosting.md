# Self-hosting the Krill Lab GitHub App

> Experimental and not actively maintained. For discovering rules, the [CLI](../README.md) is all you need.

The GitHub App:

- **On install**, it mines each repo's review history and opens a PR "🦐 Your team's rules" with `.krill/rules.md` and the rules block in `AGENTS.md` / `CLAUDE.md`. Merging that PR is how you approve the rules.
- **On every pull request**, it reviews the diff against the rules and posts inline comments. A check run fails when a *blocking* rule is broken, so branch protection can block the merge.
- **On review comments**, it stores human comments. Once enough of them point at a new pattern, it proposes new rules in a PR.
- **On push to the default branch**, it re-syncs `.krill/rules.md` into the agent files and updates the code index.

It runs on Supabase: Edge Functions (Deno), Postgres with pgvector, Vault and pg_cron.

## What you need

- A [Supabase](https://supabase.com) project, or the local stack (`supabase start`, needs Docker)
- An Anthropic API key
- Optionally, a [Voyage AI](https://www.voyageai.com) key for the code index (see `supabase/.env.example`)

## 1. Create the GitHub App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook URL:** `https://<project>.supabase.co/functions/v1/github-webhook`. For local development, use a [smee.io](https://smee.io) channel and `npx smee-client --url <channel> --target http://127.0.0.1:54321/functions/v1/github-webhook`.
- **Webhook secret:** a long random string.
- **Repository permissions:**

  | Permission | Access |
  |---|---|
  | Checks | Read & write |
  | Contents | Read & write (it commits only to `krill/*` branches) |
  | Pull requests | Read & write |
  | Metadata | Read |

- **Subscribe to events:** Pull request, Pull request review comment, Push. Installation events are always sent.

Then generate a private key (a `.pem` file). Keep it outside the repo.

## 2. Configure and deploy

```bash
cp supabase/.env.example supabase/.env   # fill it in
supabase link --project-ref <project>
supabase db push
supabase secrets set --env-file supabase/.env
supabase functions deploy github-webhook onboard index-worker ingest-rules
```

The code index is built in batches by `index-worker`. A pg_cron job restarts any batch that dies halfway, and it needs two Vault secrets. Run this in the SQL editor:

```sql
select vault.create_secret('https://<project>.supabase.co/functions/v1', 'functions_url');
select vault.create_secret('<service role key>', 'service_role_key');
```

You can skip this step if you don't set `VOYAGE_API_KEY`.

For local development:

```bash
supabase start
supabase functions serve --env-file supabase/.env
```

## 3. Install it

Install the app on a repo that has some review history. Within a few minutes you should see the "🦐 Your team's rules" PR. To re-run the analysis on a repo:

```bash
curl -X POST "https://<project>.supabase.co/functions/v1/onboard?repo=<owner>/<repo>&force=1" \
  -H "Authorization: Bearer <service role key>"
```

## Rules file format

`.krill/rules.md` has one `## Title` section per rule, with a severity line:

```markdown
## Data access goes through the service layer

UI components must not query the database directly; call a function in `services/`.

Severity: blocking

Why: reviewers asked for this in PRs #120, #187 and #203.
```

`Severity: blocking` fails the check. Anything else, or no severity line, only comments. Rules in the special `<owner>/.github` repo apply to every repo in the organization.
