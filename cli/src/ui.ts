// Terminal output: colors, ✔ steps and a spinner for long waits. No dependencies.
// Everything goes to stderr. Without an interactive terminal (CI, redirection) or with NO_COLOR there
// are no colors or animation, just lines of text. FORCE_COLOR forces colors (not the animation).
const stream = process.stderr;
const interactive = Boolean(stream.isTTY) && process.env.TERM !== "dumb";
const colors = (interactive || Boolean(process.env.FORCE_COLOR)) && !("NO_COLOR" in process.env);

const paint = (open: number, close: number) => (text: string) => (colors ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spinnerText = "";
let spinnerStart = 0;
let timer: NodeJS.Timeout | null = null;
let frame = 0;

function clearLine() {
  if (interactive) stream.write("\r\x1b[2K");
}

function render() {
  clearLine();
  stream.write(`${c.cyan(FRAMES[frame++ % FRAMES.length])} ${spinnerText} ${c.dim(elapsedSince(spinnerStart))}`);
}

// A permanent line; if a spinner is running, the line is printed above it and the spinner continues below
export function line(text = "") {
  clearLine();
  stream.write(`${text}\n`);
  if (timer) render();
}

export function done(text: string) {
  line(`${c.green("✔")} ${text}`);
}

export function warn(text: string) {
  line(`${c.yellow("!")} ${text}`);
}

export function fail(text: string) {
  stopSpinner();
  line(`${c.red("✖")} ${text}`);
}

export function startSpinner(text: string) {
  spinnerText = text;
  spinnerStart = Date.now();
  if (!interactive) return line(`… ${text}`);
  if (!timer) timer = setInterval(render, 100);
  render();
}

// Changes the running spinner's text (a counter, for example); prints nothing outside a terminal
export function updateSpinner(text: string) {
  spinnerText = text;
  if (timer) render();
}

export function stopSpinner() {
  if (timer) clearInterval(timer);
  timer = null;
  clearLine();
}

export function elapsedSince(start: number): string {
  const seconds = Math.floor((Date.now() - start) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
