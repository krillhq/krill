// End-to-end pipeline test without a model: a fake Ask returns fixed rules and audits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Ask, mineComments, type ReviewComment } from "../../supabase/functions/_shared/mining-core.ts";
import { renderReport, renderRules, writeFile } from "../src/output.ts";

const comment = (id: number, pr: number, body: string, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id, body, created_at: "2026-01-01T00:00:00Z", path: "src/ui/List.tsx", diff_hunk: "@@ -1 +1 @@\n+db.query()",
  html_url: `https://github.com/o/r/pull/${pr}#c${id}`, pull_request_url: `https://api.github.com/repos/o/r/pulls/${pr}`,
  user: { login: "ana", type: "User" }, ...extra,
});

const comments = [
  comment(1, 10, "Please move this database call into the service layer, not the component."),
  comment(2, 11, "Again a direct query from the UI; this belongs in services/ please."),
  comment(3, 12, "Typo here, should be 'receive' instead of 'recieve' in this string."),
  comment(4, 12, "Bot comment that should be ignored by the miner entirely okay.", { user: { login: "ci", type: "Bot" } }),
  comment(5, 13, "short"),
];

const ask: Ask = async (step, _system, content, schema) => {
  assert.ok(!content.includes("Bot comment"), "bots are filtered out");
  if (step === "mine") {
    return schema.parse({
      rules: [
        { title: "Data access goes through services", rule: "Do not query the DB from components.", why: "Keeps UI thin.", blocking: false, evidence_ids: ["c1", "c2"] },
        { title: "Weak rule", rule: "Spell correctly.", why: "-", blocking: false, evidence_ids: ["c3"] },
      ],
    });
  }
  return schema.parse({
    audits: [
      { rule_id: "r1", supported_evidence_ids: ["c1", "c2", "c99"], coverage: "missing", documented_in: null, coverage_note: "Not in AGENTS.md." },
      { rule_id: "r2", supported_evidence_ids: ["c3"], coverage: "missing", documented_in: null, coverage_note: "-" },
    ],
  });
};

const result = await mineComments("o/r", comments, [], ask);
assert.equal(result.humanComments, 3);
assert.equal(result.rules.length, 1, "rules with fewer than 2 verified quotes are dropped");
assert.equal(result.rules[0].evidence.length, 2, "quotes the auditor invented are ignored");
assert.deepEqual(result.rules[0].evidence.map((e) => e.pr), [10, 11]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "krill-test-"));
writeFile(dir, ".krill/rules.md", renderRules("o/r", result));
writeFile(dir, ".krill/report.md", renderReport("o/r", result));
const rules = fs.readFileSync(path.join(dir, ".krill/rules.md"), "utf8");
assert.match(rules, /## Data access goes through services/);
assert.match(rules, /Severity: warning/);
assert.match(fs.readFileSync(path.join(dir, ".krill/report.md"), "utf8"), /PR #10 · @ana/);
console.log("ok — fake mining pipeline");
