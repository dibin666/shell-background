/**
 * `/shell-bg` argument parsing and autocomplete. Pure: given the typed
 * argument text and the session's jobs, produce the parsed action or the
 * completion items — the extension wires them to pi's command API.
 *
 *   /shell-bg                 nothing (the completion list shows what there is)
 *   /shell-bg tui             open the job browser
 *   /shell-bg status          open the job browser
 *   /shell-bg status <id>     open one job's output
 *   /shell-bg kill            pick a running job to stop
 *   /shell-bg kill <id>       stop one job
 *   /shell-bg list            the old text roster, as a notification
 */
import type { Job } from "./types.ts";
import { oneLine, statusIcon } from "./widget.ts";

/** Same shape as pi-tui's AutocompleteItem, kept local so src/ stays free of pi imports. */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export const SHELL_BG_VERBS = [
  { name: "tui", description: "Open the job browser" },
  { name: "status", description: "Browse jobs and view a job's output — status [id]" },
  { name: "kill", description: "Stop a running job and its process tree — kill [id]" },
  { name: "list", description: "Print the job roster as a notification" },
] as const;

export type ShellBgVerb = (typeof SHELL_BG_VERBS)[number]["name"];

export type ShellBgAction =
  | { kind: "none" }
  | { kind: "browse" }
  | { kind: "status"; id: string }
  | { kind: "pick-kill" }
  | { kind: "kill"; id: string }
  | { kind: "list" }
  | { kind: "unknown"; verb: string };

export const SHELL_BG_USAGE = "Usage: /shell-bg [tui | status [id] | kill [id] | list]";

export function parseShellBgArgs(args: string | undefined): ShellBgAction {
  const [verb = "", id = ""] = (args ?? "").trim().split(/\s+/);
  switch (verb) {
    case "":
      return { kind: "none" };
    case "tui":
      return { kind: "browse" };
    case "status":
      return id ? { kind: "status", id } : { kind: "browse" };
    case "kill":
      return id ? { kind: "kill", id } : { kind: "pick-kill" };
    case "list":
      return { kind: "list" };
    default:
      // A bare id is read as "show me that job".
      return /^bg-\d+$/.test(verb) ? { kind: "status", id: verb } : { kind: "unknown", verb };
  }
}

/** Newest first, the order every roster here uses. */
export function sortJobs(jobs: Job[]): Job[] {
  return jobs.slice().sort((a, b) => b.startedAt - a.startedAt || idNum(b) - idNum(a));
}

function idNum(job: Job): number {
  const n = Number(job.id.replace(/^bg-/, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Does a job match a search query? By id (`bg-12`, `12`, `bg-1`) or by any
 * part of its command, case-insensitively. An empty query matches everything.
 */
export function matchesJob(job: Job, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (job.id.toLowerCase().includes(q)) return true;
  return job.command.toLowerCase().includes(q);
}

const MAX_JOB_ITEMS = 50;

/**
 * The argument text of a `/shell-bg ` line, given the text before the cursor
 * on the editor's first line — or null when the cursor is not in one.
 */
export function shellBgArgument(textBeforeCursor: string): string | null {
  const m = /^\s*\/shell-bg (.*)$/s.exec(textBeforeCursor);
  return m ? m[1]! : null;
}

/**
 * After a completion is accepted, should the list open again right away?
 * Yes when the line is left waiting for the next argument: `/shell-bg `
 * (pick a subcommand) or `/shell-bg kill ` / `/shell-bg status ` (pick a job).
 */
export function wantsFollowUpCompletion(textBeforeCursor: string): boolean {
  return /^\s*\/shell-bg\s+((kill|status)\s+)?$/.test(textBeforeCursor);
}

/**
 * Completions for the text typed after `/shell-bg `. pi replaces the whole
 * argument text with an item's `value`, so a job item carries its verb.
 * `kill` offers only running jobs — nothing else can be killed.
 */
export function completeShellBg(prefix: string, jobs: Job[]): CompletionItem[] | null {
  const text = prefix.replace(/^\s+/, "");
  const space = text.search(/\s/);

  if (space === -1) {
    const verbs = SHELL_BG_VERBS.filter((v) => v.name.startsWith(text.toLowerCase())).map((v) => ({
      value: `${v.name} `,
      label: v.name,
      description: v.description,
    }));
    return verbs.length > 0 ? verbs : null;
  }

  const verb = text.slice(0, space);
  const rest = text.slice(space).replace(/^\s+/, "");
  // An id is already complete once something follows it.
  if (/\s/.test(rest)) return null;

  let candidates: Job[];
  if (verb === "kill") candidates = jobs.filter((j) => j.status === "running");
  else if (verb === "status") candidates = jobs;
  else return null;

  const items = sortJobs(candidates)
    .filter((j) => matchesJob(j, rest))
    .slice(0, MAX_JOB_ITEMS)
    .map((j) => ({
      value: `${verb} ${j.id}`,
      label: `${statusIcon(j)} ${j.id}`,
      description: `${j.status} · ${oneLine(j.command, 60)}`,
    }));
  return items.length > 0 ? items : null;
}
