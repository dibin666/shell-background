/**
 * Turning a job (and its log tail) into the text a tool returns. Pure: given a
 * job and a tail, produce the string — the extension supplies both.
 */
import type { Job } from "./types.ts";
import { readTail } from "./tail.ts";
import { sanitizeOutput } from "./sanitize.ts";
import { DEFAULT_SHRINK, shrinkLines } from "./shrink.ts";

function kb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function secs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function duration(job: Job): string {
  const end = job.endedAt ?? Date.now();
  return secs(Math.max(0, end - job.startedAt));
}

/** `[bg-1 · done · exit 0 · 4.2s]` — the one-line header every result carries. A running job has no verdict yet: `[bg-1 · running · 13.2s]`. */
export function header(job: Job): string {
  if (job.status === "running") return `[${job.id} · running · ${duration(job)}]`;
  const verdict =
    job.status === "orphaned"
        ? "orphaned (another session)"
        : job.signal
          ? `signal ${job.signal}`
          : job.status === "killed"
            ? "killed"
            : `exit ${job.exitCode ?? "?"}`;
  return `[${job.id} · ${job.status} · ${verdict} · ${duration(job)}]`;
}

/**
 * The full result of a finished (or polled) job: the header, then the tail of
 * its output, with an honest note when output was truncated and where the whole
 * log lives. The tail is read as bytes (`tailBytes`), cleaned, and then shrunk
 * by lines (`tailLines`): first and last lines kept, every error/warning line
 * kept wherever it sits, the rest collapsed into counted markers — so a long
 * build's failing step survives in the middle instead of only its summary at
 * the end. The log on disk keeps every byte, and the note says where it is.
 */
export function formatResult(job: Job, tailBytes: number, tailLines: number = DEFAULT_SHRINK.maxLines): string {
  const tail = readTail(job.logPath, tailBytes);
  const lines = [header(job)];
  if (tail.missing) {
    // A log that cannot be read is not a command that printed nothing: say so,
    // or the model keeps polling for output that will never come.
    lines.push(`(log unavailable: ${job.logPath} could not be read)`);
    return lines.join("\n");
  }
  // Cleaned the way pi's own bash cleans its output for the model; the log on
  // disk (which the note points at) keeps every byte.
  const text = sanitizeOutput(tail.text).replace(/\n+$/, "");
  if (text.trim() === "") {
    lines.push(job.status === "running" ? "(no output yet)" : "(no output)");
    return lines.join("\n");
  }
  const shrunk = shrinkLines(text, { maxLines: tailLines, tail: Math.max(DEFAULT_SHRINK.tail, Math.floor(tailLines / 2)) });
  const notes: string[] = [];
  if (shrunk.omitted > 0) {
    notes.push(`${shrunk.omitted} of ${shrunk.total} lines omitted, none with an error or warning (those are kept wherever they sit)`);
  }
  if (tail.truncated) notes.push(`this is the last ${kb(Buffer.byteLength(tail.text, "utf8"))} of a ${kb(tail.bytes)} log`);
  if (notes.length > 0) lines.push(`… ${notes.join("; ")} — full log: ${job.logPath}`);
  lines.push(shrunk.text);
  return lines.join("\n");
}

/** A roster of jobs for `shell_status` with no id. */
export function formatList(jobs: Job[]): string {
  if (jobs.length === 0) return "No background commands this session.";
  const rows = jobs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => {
      const cmd = j.command.replace(/\s+/g, " ").trim();
      const short = cmd.length <= 48 ? cmd : `${cmd.slice(0, 47)}…`;
      return `${header(j)}  ${short}`;
    });
  return [`${jobs.filter((j) => j.status === "running").length} running, ${jobs.length} total:`, ...rows].join("\n");
}
