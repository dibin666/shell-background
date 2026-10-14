/**
 * A long log, shrunk the way a person skims it: the first lines, the last
 * lines, and every line that looks like trouble wherever it sits — the rest
 * collapsed into counted markers. Adapted from caveman's log/terminal
 * compressors (JuliusBrussee/caveman, engine/compressors/{log,terminal}.go):
 * a byte window keeps the END of a build log, which is exactly where the
 * summary is and not where the failing step was; a line window with an
 * importance regex keeps both.
 *
 * Rules that matter, kept from the original:
 * - an important line is never elided, no matter where it sits;
 * - a run of fewer than 3 dropped lines is emitted verbatim — a marker that
 *   replaces one line costs about what the line cost and reads as a hole;
 * - a marker states facts computed from exactly the lines it replaces (their
 *   log levels, counted), never a guess;
 * - markers are recognised on re-entry and kept, so shrinking a shrunk text
 *   is byte-identical — a result that re-serialises differently on a later
 *   poll busts the provider's prefix cache.
 * Pure; zero dependencies.
 */

/** Words that mark trouble, case-insensitive (`error:`, `FAILED`, `Traceback`). */
const IMPORTANT_WORDS =
  /\b(?:ERROR|FATAL|PANIC|EXCEPTION|TRACEBACK|FAIL|FAILED|FAILURE|WARN|WARNING|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b|^\s+at\s|^\s+File "|:\d+:\d+:|^\s*--->|caused by|\bexit (?:status|code) [1-9]/i;
/** camelCase error types a bare ERROR never matches: AssertionError, ValueError, NullPointerException. Case-sensitive on purpose (not "terror"). */
const CAMEL_ERROR = /\b[A-Za-z]+(?:Error|Exception)\b/;
/** A log level token, for the marker's counts. */
const LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL)\b/i;
/** A marker this module wrote earlier; kept as-is on re-entry. */
export const MARKER_RE = /^\[… \d+ lines omitted/;

export function isImportantLine(line: string): boolean {
  return IMPORTANT_WORDS.test(line) || CAMEL_ERROR.test(line) || MARKER_RE.test(line);
}

/**
 * A bare carriage return rewinds the cursor: `10%\r20%\r100% done` only ever
 * displayed `100% done`, and the earlier frames are visual history. Deleting
 * the `\r` instead (what pi's own bash does) concatenates every frame into
 * one enormous line. Keep the last non-empty segment of each line. A CRLF
 * line ending leaves an empty final segment, so the content before it wins.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      let chosen = "";
      for (const segment of line.split("\r")) if (segment.length > 0) chosen = segment;
      return chosen;
    })
    .join("\n");
}

export interface ShrinkOptions {
  /** Lines kept from the start. */
  head?: number;
  /** Lines kept from the end. */
  tail?: number;
  /** Texts of at most this many lines are returned untouched; 0 disables shrinking. */
  maxLines?: number;
}

export interface Shrunk {
  text: string;
  /** Lines replaced by markers. */
  omitted: number;
  /** Lines in the input. */
  total: number;
}

export const DEFAULT_SHRINK: Required<ShrinkOptions> = { head: 3, tail: 100, maxLines: 200 };

function levelSummary(lines: string[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const m = LEVEL.exec(line);
    if (!m) continue;
    const key = m[1]!.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  // Every level seen, never a partial list; most frequent first, ties by name.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([level, n]) => `${level} ×${n}`)
    .join(", ");
}

function marker(run: number, dropped: string[]): string {
  const summary = levelSummary(dropped);
  return `[… ${run} lines omitted${summary ? ` (${summary})` : ""} …]`;
}

export function shrinkLines(text: string, opts: ShrinkOptions = {}): Shrunk {
  const head = Math.max(0, opts.head ?? DEFAULT_SHRINK.head);
  const tail = Math.max(0, opts.tail ?? DEFAULT_SHRINK.tail);
  const maxLines = opts.maxLines ?? DEFAULT_SHRINK.maxLines;
  const lines = text.split("\n");
  const total = lines.length;
  if (maxLines <= 0 || total <= maxLines) return { text, omitted: 0, total };
  const keep = lines.map((line, i) => i < head || i >= total - tail || isImportantLine(line));
  const out: string[] = [];
  let omitted = 0;
  let i = 0;
  while (i < total) {
    if (keep[i]) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < total && !keep[j]) j++;
    const run = j - i;
    if (run < 3) {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    } else {
      out.push(marker(run, lines.slice(i, j)));
      omitted += run;
    }
    i = j;
  }
  return { text: out.join("\n"), omitted, total };
}
