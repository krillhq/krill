// Generates docs/demo.svg: an animated, looping terminal with the real output of
// `npx krill-rules excalidraw/excalidraw`. SMIL animation, no dependencies: GitHub plays it like a GIF.
// Usage: node docs/make-demo.mjs [--static]   (--static draws the last frame, for review)
import fs from "node:fs";

const STATIC = process.argv.includes("--static");
const LOOP = 22; // seconds
const WIDTH = 940;
const LINE = 22;
const TOP = 52;
const LEFT = 20;
const CHAR = 8.43; // width of one monospace character at 14px

const C = {
  bg: "#0d1117",
  bar: "#161b22",
  text: "#c9d1d9",
  dim: "#8b949e",
  green: "#3fb950",
  red: "#f85149",
  cyan: "#79c0ff",
  yellow: "#d29922",
};

// Each line: segments [text, color, style?], when it appears and, for commands, how long typing takes
const lines = [
  { at: 0.6, type: 1.8, seg: [["$ ", C.green], ["npx krill-rules excalidraw/excalidraw", C.text]] },
  { at: 3.0, seg: [["Reading review comments of excalidraw/excalidraw…", C.dim]] },
  { at: 3.8, seg: [["  1000 comments · existing docs: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, CONTRIBUTING.md", C.dim]] },
  { at: 4.6, seg: [["Mining rules with claude-code (haiku)… this takes a few minutes.", C.text]] },
  { at: 6.0, seg: [["  ⏱  ~4 minutes later", C.yellow, "italic"]] },
  { at: 7.0, seg: [["26 rules from 400 human comments · 26 not (fully) documented yet", C.green, "bold"]] },
  { at: 7.5, seg: [["wrote: .krill/rules.md, .krill/report.md", C.text]] },
  { gap: true },
  { at: 8.8, type: 1.2, seg: [["$ ", C.green], ["less .krill/report.md", C.text]] },
  { at: 10.6, seg: [["## 11. ⛔ Modify existing elements with mutateElement and derive copies with newElementWith", C.text, "bold"]] },
  { at: 11.1, seg: [["❌ Missing", C.red], [" · no file says to modify elements only via mutateElement", C.dim]] },
  { at: 11.6, seg: [["- ", C.dim], ["PR #9246 · @dwelle", C.cyan], [": \"using `Object.assign` will not bump version and such…\"", C.text]] },
  { at: 12.0, seg: [["- ", C.dim], ["PR #9313 · @mtolmacs", C.cyan], [": \"Use `newElementWith()` if you're creating a new element…\"", C.text]] },
  { gap: true },
  { at: 13.8, type: 1.0, seg: [["$ ", C.green], ["npx krill-rules sync", C.text]] },
  { at: 15.4, seg: [["Copied .krill/rules.md into: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md", C.green]] },
];

const HEIGHT = TOP + lines.length * LINE + 24;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const k = (t) => (t / LOOP).toFixed(4);

// Visible from `at` until just before the loop ends; then everything clears and starts again
function fadeIn(at) {
  if (STATIC) return "";
  return `<animate attributeName="opacity" dur="${LOOP}s" repeatCount="indefinite" calcMode="discrete" values="0;1;0" keyTimes="0;${k(at)};${k(LOOP - 0.6)}"/>`;
}

// Typing effect: the clip widens one character at a time
function typing(id, x, y, chars, at, duration) {
  const fullWidth = (chars * CHAR + 2).toFixed(1);
  if (STATIC) return `<clipPath id="${id}"><rect x="${x}" y="${y - 16}" width="${fullWidth}" height="${LINE}"/></clipPath>`;
  const values = ["0"];
  const times = ["0"];
  for (let i = 1; i <= chars; i++) {
    values.push((i * CHAR + 2).toFixed(1));
    times.push(k(at + (duration * i) / chars));
  }
  values.push("0");
  times.push(k(LOOP - 0.6));
  return `<clipPath id="${id}"><rect x="${x}" y="${y - 16}" height="${LINE}" width="0"><animate attributeName="width" dur="${LOOP}s" repeatCount="indefinite" calcMode="discrete" values="${values.join(";")}" keyTimes="${times.join(";")}"/></rect></clipPath>`;
}

const body = [];
const defs = [];
lines.forEach((line, i) => {
  if (line.gap) return;
  const y = TOP + i * LINE + 14;
  const spans = line.seg
    .map(([text, color, style]) => {
      const weight = style === "bold" ? ' font-weight="700"' : "";
      const italic = style === "italic" ? ' font-style="italic"' : "";
      return `<tspan fill="${color}"${weight}${italic}>${esc(text)}</tspan>`;
    })
    .join("");
  if (line.type) {
    // The "$ " prompt appears at once; the command is typed
    const [prompt, ...rest] = line.seg;
    const cmdChars = rest.map(([t]) => t).join("").length;
    const cmdX = LEFT + prompt[0].length * CHAR;
    defs.push(typing(`t${i}`, cmdX, y, cmdChars, line.at, line.type));
    body.push(`<g opacity="${STATIC ? 1 : 0}">${fadeIn(line.at - 0.3)}<text x="${LEFT}" y="${y}" xml:space="preserve"><tspan fill="${prompt[1]}">${esc(prompt[0])}</tspan></text></g>`);
    const cmd = rest.map(([text, color]) => `<tspan fill="${color}">${esc(text)}</tspan>`).join("");
    body.push(`<text x="${cmdX}" y="${y}" clip-path="url(#t${i})" xml:space="preserve">${cmd}</text>`);
  } else {
    body.push(`<g opacity="${STATIC ? 1 : 0}">${fadeIn(line.at)}<text x="${LEFT}" y="${y}" xml:space="preserve">${spans}</text></g>`);
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="krill-rules finds 26 undocumented rules in excalidraw's review history and syncs them into AGENTS.md and CLAUDE.md">
<title>krill-rules demo on excalidraw/excalidraw</title>
<defs>${defs.join("")}</defs>
<rect width="${WIDTH}" height="${HEIGHT}" rx="10" fill="${C.bg}"/>
<path d="M0 10a10 10 0 0 1 10-10h${WIDTH - 20}a10 10 0 0 1 10 10v24H0z" fill="${C.bar}"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text x="${WIDTH / 2}" y="22" text-anchor="middle" fill="${C.dim}" font-size="12" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">~/excalidraw</text>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="14">
${body.join("\n")}
</g>
</svg>
`;

const out = new URL(STATIC ? "./demo-static.svg" : "./demo.svg", import.meta.url);
fs.writeFileSync(out, svg);
console.log(`${out.pathname} · ${(svg.length / 1024).toFixed(1)} KB`);
