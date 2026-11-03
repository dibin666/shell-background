/**
 * The aboveEditor box listing background jobs — running ones, and any that
 * finished in the last 15s so a completion is visible before it disappears.
 * Pure string builder; the extension wraps it in a small clickable component
 * (a click on a job row opens that job's detail, a click elsewhere opens the
 * job browser), so the builder also reports which job each row shows.
 */
import type { Job } from "./types.ts";

const WIDTH = 54;
const MAX_ROWS = 8;

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** The status glyph used everywhere a job is shown: widget, completions, browser. */
export function statusIcon(job: Pick<Job, "status">): string {
  switch (job.status) {
    case "running":
      return "⟳";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "◼";
  }
}

/**
 * The theme color that goes with {@link statusIcon} — one per status, so a
 * roster tells running, finished, failed, stopped (killed) and closed-with-its-
 * session (orphaned) apart at a glance.
 */
export function statusColor(job: Pick<Job, "status">): string {
  switch (job.status) {
    case "running":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "error";
    case "killed":
      return "accent";
    default:
      return "dim";
  }
}

/** Every status in display order, for legends. */
export const STATUS_ORDER = ["running", "done", "failed", "killed", "orphaned"] as const;

/** The extension's own glyph, shown in the widget title and the browser frame. */
export const SHELL_BG_ICON = "⚙";

export function elapsed(job: Job, now: number): string {
  const end = job.endedAt ?? now;
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Collapse whitespace to single spaces and clip to `max` characters. */
export function oneLine(text: string, max = Infinity): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export interface WidgetModel {
  lines: string[];
  /** One entry per line: the id of the job that line shows, or null for chrome (title, border, "+N more"). */
  rowIds: Array<string | null>;
}

export function buildWidget(jobs: Job[], theme: WidgetTheme, now: number): WidgetModel {
  const dim = (s: string) => theme.fg("dim", s);
  const visible = jobs
    .filter((j) => j.status === "running" || (j.endedAt ?? 0) > now - 15_000)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (visible.length === 0) return { lines: [], rowIds: [] };

  const running = visible.filter((j) => j.status === "running").length;
  const title = ` ${SHELL_BG_ICON} shell-bg · ${running} running `;
  const hint = " /shell-bg ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  const lines = [dim(`╭${title}${"─".repeat(pad)}${hint}╮`)];
  const rowIds: Array<string | null> = [null];

  const shown = visible.slice(-MAX_ROWS);
  const hidden = visible.length - shown.length;
  for (const j of shown) {
    const c = statusColor(j);
    lines.push(
      `${theme.fg(c, statusIcon(j))} ${theme.fg(c, j.id)} ${dim(`· ${elapsed(j, now)}`)} ${dim(oneLine(j.command, 28))}`,
    );
    rowIds.push(j.id);
  }
  if (hidden > 0) {
    lines.push(dim(`│ … +${hidden} more`));
    rowIds.push(null);
  }
  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  rowIds.push(null);
  return { lines, rowIds };
}
