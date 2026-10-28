// Plain-text helpers (no React/Convex imports; tested under node --test).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Verify/setup scripts often print coloured output (vitest, npm); the step feedback shows plain text. */
export function stripAnsi(text: string) {
  return text.replace(ANSI, "");
}
