# 🦐 Krill Lab

**Find the rules your code reviewers keep repeating but nobody wrote down, and put them where your AI coding agents will read them.**

<p align="center"><img src="docs/demo.svg" alt="krill-rules finds 26 undocumented rules in the review history of excalidraw/excalidraw and syncs them into AGENTS.md and CLAUDE.md" width="100%"></p>

Every team has unwritten rules. They live in pull request comments: *"move this query into the service layer"*, *"we already have a helper for that"*, *"restore the fake timers in `afterEach`"*. New teammates and AI agents (Claude Code, Cursor, Copilot) break them over and over, because they aren't in `AGENTS.md` or `CLAUDE.md`.

Krill reads a repo's review history, finds the rules reviewers ask for again and again, checks which ones are already documented, and writes the missing ones into `AGENTS.md` / `CLAUDE.md`.

```
$ npx krill-rules documenso/documenso
Reading review comments of documenso/documenso…
  1000 comments · existing docs: AGENTS.md, .cursorrules, CONTRIBUTING.md
Mining rules with claude-code (haiku)…

10 rules from 66 human comments · 10 not (fully) documented yet
wrote: .krill/rules.md, .krill/report.md
```

One of those 10 rules, shortened from `.krill/report.md`, with the review comments behind it:

```markdown
## Use one ICU plural message per sentence in Lingui

For count-dependent text, write the whole sentence in a single `<Plural value={n} one="... # ..."
other="... # ..." />`, using `#` for the number. Do not nest `<Plural>` inside `<Trans>`, and do
not split one sentence across several plural tags.

❌ Missing · AGENTS.md and .cursorrules only require <Trans> and the t macro for translations;
neither mentions Lingui plural handling.

- PR #3251 · @mKoonrad: "Something is wrong. Why you add Plural tag inside Trans? Why you dont
  add `#` char inside one and other value?…"
- PR #3250 · @mKoonrad: "Why not just basic implementation, like few lines above, without mixing
  Plural tag inside Trans?…"
```

It took under two minutes, on a Claude subscription.

## Quick start

You need [Node.js 20+](https://nodejs.org) and the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`). Krill reads review comments through `gh`, so it works on any repo you can see, private ones included.

```bash
# Inside a checkout of the repo (or pass owner/repo)
npx krill-rules

# Review .krill/rules.md: edit, delete, add. Then copy the rules into your agent files:
npx krill-rules sync
```

`sync` writes the rules into a delimited block in `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and `.github/copilot-instructions.md`, whichever exist (it creates `AGENTS.md` if none do). Everything outside the block is left untouched, and running it again only replaces the block.

## Bring your own model

Krill never sends your code anywhere you didn't choose. Pick a provider:

| Provider | What you need | Cost |
|---|---|---|
| `claude-code` | [Claude Code](https://claude.com/claude-code) installed and logged in | Uses your existing subscription |
| `anthropic` | `ANTHROPIC_API_KEY` | A few cents per repo with Haiku |
| `ollama` | [Ollama](https://ollama.com) running locally | Free, runs on your machine; quality depends on the model |

```bash
npx krill-rules --provider ollama --model qwen2.5:14b
npx krill-rules --provider anthropic --model claude-sonnet-5-5
```

By default Krill uses `anthropic` if `ANTHROPIC_API_KEY` is set, otherwise `claude-code`. Run `npx krill-rules --help` for every option.

## How it works

1. **Collect.** It downloads up to 1,000 recent PR review comments and drops bots, replies and one-word comments.
2. **Mine.** The model proposes rules that show up in at least two comments, each one citing the comments behind it. The rules have to be specific to the project (real module names, libraries, conventions), not generic advice. Each rule is marked *blocking* or *warning*.
3. **Audit.** A second, skeptical pass checks every citation and throws out any that don't really say what the rule says. It also compares each rule with your existing `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `CONTRIBUTING.md`… and labels it *documented*, *partial* or *missing*.
4. **Keep.** Only rules with at least two verified citations make it into `.krill/rules.md`.

## Results on real repos

We ran the mining pipeline (the scripts in [`experiments/`](experiments/), which the CLI is built from) on two open source repos:

| Repo | Rules found | Not documented, or only partly |
|---|---|---|
| [tldraw/tldraw](https://github.com/tldraw/tldraw) | 25 | 25 (14 missing, 11 partial) |
| [documenso/documenso](https://github.com/documenso/documenso) | 10 | 9 (5 missing, 4 partial) |

We also tested whether these rules help an AI **review PRs**. They don't help much. On 15 tldraw PRs with 54 human review comments, a Claude Haiku reviewer anticipated 19% of the human comments with only the repo's `AGENTS.md`, and 24% with Krill's rules and code context added. Krill also produced more findings (115 vs 86), so its precision was about the same. With a sample this small, the difference is noise. The setup and data are in [`experiments/`](experiments/).

Our takeaway: frontier models already review code well. Where Krill adds something is **surfacing team knowledge nobody wrote down**, so humans and agents can follow it from the first line.

## What's in this repo

```
cli/          krill-rules: the CLI above (Node, no server)
supabase/     Krill Lab GitHub App (self-hosted, experimental): reviews PRs against the rules,
              fails the check on blocking violations, learns new rules from review comments,
              keeps AGENTS.md / CLAUDE.md in sync. Supabase Edge Functions + Postgres/pgvector.
experiments/  The mining and evaluation scripts behind the numbers above.
examples/     A hand-written rules file.
```

The CLI and the GitHub App share the same mining code (`supabase/functions/_shared/mining-core.ts`).

To run the GitHub App yourself, see [docs/self-hosting.md](docs/self-hosting.md). It's experimental and isn't actively maintained.

## Status

Krill Lab began as a startup experiment and is now open source as-is. The CLI is small and should stay easy to maintain. Issues and PRs are welcome, but responses may be slow.

## License

[MIT](LICENSE)
