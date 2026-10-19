# Experiments

The scripts behind the numbers in the main README. They read GitHub through `gh` and cache downloads in `mine-rules/data/` (gitignored).

```bash
cd experiments/mine-rules
npm install
export ANTHROPIC_API_KEY=...        # or put it in supabase/.env
export KRILL_MODEL=claude-haiku-5-5 # default
```

## Mining report: `report.ts`

```bash
npx tsx report.ts documenso/documenso
npx tsx render.ts reports/documenso.json   # self-contained HTML page
```

This finds the unwritten rules in a repo's review history and compares them with its guideline files. It's the prototype of the CLI.

## Review evaluation: `eval.ts`

The question: does a reviewer that knows the team's mined rules anticipate what human reviewers ask for better than plain *Claude + the repo's `AGENTS.md`*?

1. The history is split by date. Rules are learned only from review comments posted **before** the first test PR.
2. Each test PR is reviewed at the commit the human reviewers saw, with the same model and prompt:
   - **baseline**: the repo's guideline files (`AGENTS.md`, `CLAUDE.md`…)
   - **Krill**: baseline + the mined rules + repo context (similar existing code and a catalog of shared helpers, built from a code index at the cutoff date; this needs `VOYAGE_API_KEY`)
3. An LLM judge matches each review's findings with that PR's human comments.

```bash
npx tsx eval.ts tldraw/tldraw --prs 15
```

### Result on tldraw/tldraw (Claude Haiku, total cost $0.27)

[`results/tldraw-summary.json`](mine-rules/results/tldraw-summary.json) has the summary and the 25 rules learned from 246 earlier review comments.

| | Human comments anticipated (of 54) | Findings | Findings that matched a human comment |
|---|---|---|---|
| Baseline | 18.5% | 86 | 16 |
| Krill | 24.1% | 115 | 19 |

Krill caught a few more human comments, but it also commented more, so precision was about the same (Krill 17%, baseline 19%). Fifteen PRs is too small a sample to call that difference real. Nobody checked whether the findings that didn't match a human comment were useful.

`eval.ts` now also has a middle variant (baseline + rules, no code context) to separate the two effects. That three-way run was never completed.

## `sandbox/seed.sh`

This creates a small private repo with a scripted review history, for testing the GitHub App's onboarding end to end.
