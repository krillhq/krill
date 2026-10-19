// Turns reports/<repo>.json into a self-contained HTML page to share.
//
// Usage: npx tsx render.ts reports/documenso.json
import fs from "node:fs";

type Coverage = "missing" | "partial" | "documented";

interface Report {
  repo: string;
  generated_at: string;
  period: { from: string; to: string };
  stats: {
    total_comments: number;
    human_comments: number;
    bot_comments: Record<string, number>;
    prs_reviewed: number;
    reviewers: Record<string, number>;
  };
  documented_files: string[];
  rules: {
    title: string;
    rule: string;
    why: string;
    category: string;
    checkable_in_diff: boolean;
    coverage: Coverage;
    documented_in: string | null;
    documented_quote: string | null;
    coverage_note: string;
    prs: number;
    reviewers: Record<string, number>;
    evidence: { pr: number; reviewer: string; path: string; url: string; quote: string }[];
  }[];
}

const VISIBLE_EVIDENCE = 3;

const TEXT = {
  eyebrow: "Krill Lab · Unwritten rules",
  lede: (n: number, gap: number, files: string) =>
    `Your reviewers keep asking for <strong>${n} rules</strong> in pull requests. <strong>${gap}</strong> are missing or only partly written down in ${files}.`,
  noFiles: "any of the repository's guideline files",
  statRules: "rules detected",
  statGap: "missing or partial",
  statHuman: "human review comments analyzed",
  statBots: "of review comments come from bots",
  period: (from: string, to: string, prs: number) => `Reviews from ${from} to ${to} · ${prs} PRs`,
  filterAll: "All",
  coverage: { missing: "Not documented", partial: "Partly documented", documented: "Already documented" },
  docsSays: "What your docs say",
  docsNothing: "No file mentions it.",
  evidence: (n: number, prs: number) => `${n} ${n === 1 ? "comment" : "comments"} across ${prs} PRs`,
  more: (n: number) => `Show ${n} more`,
  why: "Why",
  diff: "Checkable in the diff",
  process: "Process",
  category: {
    architecture: "Architecture",
    api_design: "API design",
    performance: "Performance",
    security: "Security",
    testing: "Testing",
    compatibility: "Compatibility",
    maintainability: "Maintainability",
    i18n: "Internationalization",
    documentation: "Documentation",
  } as Record<string, string>,
  methodTitle: "How this report was made",
  method: (total: number, human: number) =>
    `We analyzed the ${total} most recent review comments in the repository. We dropped bot comments, in-thread replies and trivial remarks, which left ${human}. A rule only appears here if at least two comments ask for it directly; a second pass verified every quote and compared each rule with your guideline files. Everything is public, and every quote links to the original comment.`,
  ctaTitle: "What Krill Lab can do with this",
  cta: "Turn these rules into team-approved standards, sync them to AGENTS.md, CLAUDE.md and .cursorrules so AI agents follow them while writing code, and check them on every pull request.",
  generated: "Generated on",
};

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// `code` in the rules' text → <code>
function inline(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function render(report: Report): string {
  const t = TEXT;
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const gap = report.rules.filter((r) => r.coverage !== "documented").length;
  const bots = Object.values(report.stats.bot_comments).reduce((a, b) => a + b, 0);
  const botShare = Math.round((bots / report.stats.total_comments) * 100);
  const files = report.documented_files.length
    ? report.documented_files.map((f) => `<code>${esc(f)}</code>`).join(", ")
    : t.noFiles;
  const counts = (["missing", "partial", "documented"] as Coverage[]).map(
    (c) => [c, report.rules.filter((r) => r.coverage === c).length] as const,
  );

  const rules = report.rules
    .map((r, i) => {
      const reviewers = Object.entries(r.reviewers)
        .map(([u, n]) => `@${esc(u)}${n > 1 ? ` ×${n}` : ""}`)
        .join(", ");
      const quote = (e: Report["rules"][number]["evidence"][number]) => `
          <li>
            <a href="${esc(e.url)}" target="_blank" rel="noopener"><span class="pr">#${e.pr}</span> @${esc(e.reviewer)}</a>
            <q>${esc(e.quote)}</q>
          </li>`;
      const shown = r.evidence.slice(0, VISIBLE_EVIDENCE).map(quote).join("");
      const rest = r.evidence.slice(VISIBLE_EVIDENCE);
      const docs = r.documented_in
        ? `<p class="docs-file"><code>${esc(r.documented_in)}</code></p>${
            r.documented_quote ? `<blockquote>${inline(r.documented_quote)}</blockquote>` : ""
          }`
        : `<p class="docs-none">${t.docsNothing}</p>`;

      return `
    <article class="rule" data-coverage="${r.coverage}" id="rule-${i + 1}">
      <header class="rule-head">
        <span class="chip chip-${r.coverage}">${t.coverage[r.coverage]}</span>
        <span class="rule-num">${String(i + 1).padStart(2, "0")}</span>
      </header>
      <h2>${inline(r.title)}</h2>
      <p class="rule-text">${inline(r.rule)}</p>
      <p class="rule-why"><span>${t.why}.</span> ${inline(r.why)}</p>
      <div class="rule-grid">
        <section class="docs">
          <h3>${t.docsSays}</h3>
          ${docs}
          <p class="gap-note">${inline(r.coverage_note)}</p>
        </section>
        <section class="evidence">
          <h3>${t.evidence(r.evidence.length, r.prs)} · ${reviewers}</h3>
          <ul>${shown}</ul>
          ${
            rest.length
              ? `<details><summary>${t.more(rest.length)}</summary><ul>${rest.map(quote).join("")}</ul></details>`
              : ""
          }
        </section>
      </div>
      <p class="rule-meta">${esc(t.category[r.category] ?? r.category)} · ${r.checkable_in_diff ? t.diff : t.process}</p>
    </article>`;
    })
    .join("\n");

  return `<title>${esc(report.repo.split("/")[1])} · Krill Lab</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column; key figures on top, then each rule as an audit card with its evidence. */
:root {
  --bg: #f4f7f7;
  --surface: #ffffff;
  --fg: #11201f;
  --muted: #566866;
  --line: #d9e2e1;
  --accent: #d6455d;        /* krill: the gap between what's asked for and what's written */
  --accent-soft: #fbe6ea;
  --partial: #a66a00;
  --partial-soft: #fbf0d9;
  --ok: #1f7a62;
  --ok-soft: #dcf1ea;
  --quote: #eef3f2;
  --font-display: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
  --font-body: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0c1515; --surface: #132020; --fg: #e3eceb; --muted: #94a8a5; --line: #263735;
    --accent: #f27a8e; --accent-soft: #3a1820; --partial: #e2ad4a; --partial-soft: #33270f;
    --ok: #5cc4a5; --ok-soft: #12302a; --quote: #182828; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0c1515; --surface: #132020; --fg: #e3eceb; --muted: #94a8a5; --line: #263735;
  --accent: #f27a8e; --accent-soft: #3a1820; --partial: #e2ad4a; --partial-soft: #33270f;
  --ok: #5cc4a5; --ok-soft: #12302a; --quote: #182828; color-scheme: dark;
}

* { box-sizing: border-box; }
body {
  background: var(--bg); color: var(--fg);
  font: 400 1rem/1.6 var(--font-body);
  padding-inline: 16px; padding-block: 0;
}
.page { max-width: 54rem; margin: 0 auto; padding-block: 3rem 4rem; display: grid; gap: 2.5rem; }
code { font-family: var(--font-mono); font-size: .88em; background: var(--quote); padding: .05em .35em; border-radius: 4px; overflow-wrap: anywhere; }
a { color: inherit; }
a:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Header */
.intro { display: grid; gap: 1rem; }
.eyebrow { font: 500 .78rem/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin: 0; }
h1 { font: 700 clamp(2.2rem, 6vw, 3.4rem)/1.05 var(--font-display); letter-spacing: -.02em; margin: 0; text-wrap: balance; overflow-wrap: anywhere; }
.lede { font-size: 1.2rem; line-height: 1.5; max-width: 40rem; margin: 0; text-wrap: pretty; }
.lede strong { color: var(--accent); font-weight: 600; }
.period { font: 400 .85rem/1.4 var(--font-mono); color: var(--muted); margin: 0; }

.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--line); }
.stat { padding: 1.1rem 1rem 1.1rem 0; display: grid; gap: .35rem; align-content: start; }
.stat + .stat { padding-left: 1rem; border-left: 1px solid var(--line); }
.stat b { font: 700 2.2rem/1 var(--font-display); font-variant-numeric: tabular-nums; }
.stat:nth-child(2) b { color: var(--accent); }
.stat span { font-size: .85rem; line-height: 1.35; color: var(--muted); }
@media (max-width: 640px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(3) { padding-left: 0; border-left: 0; }
  .stat:nth-child(n+3) { border-top: 1px solid var(--line); }
}

/* Filters */
.filters { display: flex; flex-wrap: wrap; gap: .5rem; }
.filters button {
  font: 500 .85rem/1 var(--font-body); color: var(--fg); background: var(--surface);
  border: 1px solid var(--line); border-radius: 999px; padding: .55rem .9rem; cursor: pointer;
}
.filters button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.filters button span { font-family: var(--font-mono); opacity: .7; margin-left: .3rem; }

/* Rules */
.rules { display: grid; gap: 1.25rem; }
.rule {
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 1.5rem; display: grid; gap: .75rem; min-width: 0;
}
.rule-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.rule-num { font: 500 .85rem/1 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.chip { font: 600 .75rem/1 var(--font-body); letter-spacing: .02em; padding: .4rem .65rem; border-radius: 999px; }
.chip-missing { color: var(--accent); background: var(--accent-soft); }
.chip-partial { color: var(--partial); background: var(--partial-soft); }
.chip-documented { color: var(--ok); background: var(--ok-soft); }
.rule h2 { font: 700 1.35rem/1.25 var(--font-display); margin: 0; text-wrap: balance; }
.rule-text { margin: 0; max-width: 46rem; }
.rule-why { margin: 0; color: var(--muted); font-size: .95rem; max-width: 46rem; }
.rule-why span { font-weight: 600; color: var(--fg); }
.rule-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 1.25rem; margin-top: .5rem; }
@media (max-width: 720px) { .rule-grid { grid-template-columns: minmax(0, 1fr); } }
.rule h3 { font: 500 .72rem/1.4 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 .5rem; }
.docs { border-top: 2px solid var(--line); padding-top: .75rem; min-width: 0; }
.rule[data-coverage="missing"] .docs { border-top-color: var(--accent); }
.rule[data-coverage="partial"] .docs { border-top-color: var(--partial); }
.rule[data-coverage="documented"] .docs { border-top-color: var(--ok); }
.docs-file { margin: 0 0 .35rem; }
.docs-none { margin: 0 0 .5rem; font-weight: 500; }
.docs blockquote { margin: 0 0 .6rem; padding-left: .75rem; border-left: 2px solid var(--line); font-size: .9rem; color: var(--muted); }
.gap-note { margin: 0; font-size: .9rem; }
.evidence { border-top: 2px solid var(--line); padding-top: .75rem; min-width: 0; }
.evidence ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
.evidence li { background: var(--quote); border-radius: 6px; padding: .6rem .75rem; display: grid; gap: .25rem; min-width: 0; }
.evidence li a { font: 500 .8rem/1.3 var(--font-mono); color: var(--muted); text-decoration: none; }
.evidence li a:hover { color: var(--accent); text-decoration: underline; }
.evidence .pr { color: var(--fg); }
.evidence q { font-size: .9rem; line-height: 1.5; overflow-wrap: anywhere; }
.evidence q::before, .evidence q::after { content: none; }
details { margin-top: .6rem; }
details ul { margin-top: .6rem; }
summary { cursor: pointer; font-size: .85rem; font-weight: 500; color: var(--muted); }
.rule-meta { margin: 0; font: 400 .78rem/1.4 var(--font-mono); color: var(--muted); }

/* Footer */
.closing { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 2rem; border-top: 1px solid var(--line); padding-top: 2rem; }
@media (max-width: 720px) { .closing { grid-template-columns: minmax(0, 1fr); } }
.closing h2 { font: 700 1.1rem/1.3 var(--font-display); margin: 0 0 .5rem; }
.closing p { margin: 0; font-size: .92rem; color: var(--muted); }
.closing .cta p { color: var(--fg); }
.closing .cta a { display: inline-block; margin-top: .75rem; font-weight: 600; color: var(--accent); }
.footnote { font: 400 .78rem/1.4 var(--font-mono); color: var(--muted); margin: 0; }
@media (prefers-reduced-motion: no-preference) { .filters button { transition: background .15s, color .15s; } }
</style>

<main class="page">
  <header class="intro">
    <p class="eyebrow">${t.eyebrow}</p>
    <h1>${esc(report.repo)}</h1>
    <p class="lede">${t.lede(report.rules.length, gap, files)}</p>
    <p class="period">${t.period(fmtDate(report.period.from), fmtDate(report.period.to), report.stats.prs_reviewed)}</p>
  </header>

  <section class="stats" aria-label="Resumen">
    <div class="stat"><b>${report.rules.length}</b><span>${t.statRules}</span></div>
    <div class="stat"><b>${gap}</b><span>${t.statGap}</span></div>
    <div class="stat"><b>${report.stats.human_comments}</b><span>${t.statHuman}</span></div>
    <div class="stat"><b>${botShare}%</b><span>${t.statBots}</span></div>
  </section>

  <nav class="filters" aria-label="Filtro">
    <button type="button" data-filter="all" aria-pressed="true">${t.filterAll}<span>${report.rules.length}</span></button>
    ${counts
      .filter(([, n]) => n > 0)
      .map(
        ([c, n]) =>
          `<button type="button" data-filter="${c}" aria-pressed="false">${t.coverage[c]}<span>${n}</span></button>`,
      )
      .join("\n    ")}
  </nav>

  <div class="rules">
${rules}
  </div>

  <footer class="closing">
    <section>
      <h2>${t.methodTitle}</h2>
      <p>${t.method(report.stats.total_comments, report.stats.human_comments)}</p>
    </section>
    <section class="cta">
      <h2>${t.ctaTitle}</h2>
      <p>${t.cta}</p>
      <a href="https://www.getkrill.ai" target="_blank" rel="noopener">getkrill.ai</a>
    </section>
  </footer>
  <p class="footnote">${t.generated} ${fmtDate(report.generated_at)}</p>
</main>

<script>
  const buttons = document.querySelectorAll(".filters button");
  const rules = document.querySelectorAll(".rule");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      rules.forEach((rule) => { rule.hidden = filter !== "all" && rule.dataset.coverage !== filter; });
    });
  });
</script>
`;
}

const input = process.argv[2];
if (!input?.endsWith(".json")) throw new Error("Usage: npx tsx render.ts reports/<repo>.json");
const output = input.replace(/\.json$/, ".html");
fs.writeFileSync(output, render(JSON.parse(fs.readFileSync(input, "utf8")) as Report));
console.log(`→ ${output}`);
