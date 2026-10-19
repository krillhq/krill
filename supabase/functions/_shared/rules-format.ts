// Format of .krill/rules.md: one "## Title" section per rule, with a "Severity: blocking | warning"
// line. A rule without that line is a warning.

export const RULES_PATH = ".krill/rules.md";

export interface TeamRule {
  title: string;
  blocking: boolean;
}

const SEVERITY_LINE = /^severity\s*:\s*\**\s*([a-z]+)/im;

export function parseRules(markdown: string): TeamRule[] {
  return markdown
    .split(/^## /m)
    .slice(1) // everything before the first "## " is the title and intro
    .map((section) => {
      const [firstLine, ...rest] = section.split("\n");
      const severity = SEVERITY_LINE.exec(rest.join("\n"))?.[1]?.toLowerCase();
      return { title: firstLine.trim(), blocking: severity === "blocking" };
    })
    .filter((r) => r.title.length > 0);
}

export function severityLine(blocking: boolean): string {
  return `Severity: ${blocking ? "blocking" : "warning"}`;
}
