/**
 * Shared shapes for @pify/shell-background.
 * No imports from pi packages: src/ typechecks and unit-tests standalone.
 */

export type JobStatus = "running" | "done" | "failed" | "killed" | "orphaned";

export interface Job {
  /** Short session-monotonic id, e.g. "bg-1". */
  id: string;
  command: string;
  cwd: string;
  /** OS pid of the shell process; null before spawn or if spawn failed. */
  pid: number | null;
  /**
   * pid of the pi host that spawned this job. A record whose hostPid is not the
   * current process was written by another (or a since-crashed) host: its pid is
   * not ours to signal, so it is never treated as running here. A `/reload`
   * keeps the same host pid, so genuine reload survivors still adopt. Optional
   * so a pre-upgrade sidecar (no hostPid) is simply treated as foreign.
   */
  hostPid?: number;
  status: JobStatus;
  /** Process exit code, once finished. */
  exitCode: number | null;
  /** Terminating signal name, if the process was signalled. */
  signal: string | null;
  /** Absolute path of the merged stdout+stderr log file. */
  logPath: string;
  startedAt: number;
  endedAt: number | null;
  /** True if it reached the background because it outran the auto-threshold, */
  /** false if the caller asked for background up front. */
  auto: boolean;
  /** Whether the finished result has been delivered back to the conversation. */
  delivered: boolean;
  /** Set when we killed it (timeout/abort/shell_kill), so exit reads as killed. */
  killedByUs?: boolean;
  /**
   * Set when the user stopped it from the UI (/shell-bg kill, the job
   * browser) rather than the model: its result then says so, and is handed to
   * the model with the user's next message instead of waking it for a turn.
   */
  stoppedByUser?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finished job is anything past running. */
export function isFinished(job: Job): boolean {
  return job.status !== "running";
}
