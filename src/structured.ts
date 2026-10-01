/**
 * The machine-readable half of a result.
 *
 * pi 0.99's bash declares an `outputSchema` and returns `structuredContent`:
 * the model still sees the text, but programmatic callers — codemode scripts,
 * tools calling `ctx.executeTool("bash", …)` — receive the structured value
 * (up to 1 MiB of output, not the model-facing tail). This package replaces
 * that tool, so it has to speak the same shape or every script that reads
 * `result.exit_code` breaks the moment it is installed. The fields pi's bash
 * has are kept with the same names and meanings; `status` and `job_id` are
 * added because a command here can still be running when the tool returns —
 * in which case `exit_code` is absent, which is how a script tells.
 */
import { Type, type Static } from "typebox";
import type { Job } from "./types.ts";
import type { FullOutput } from "./tail.ts";

export const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

export const bashOutputSchema = Type.Object({
  output: Type.String({
    description: "Combined stdout and stderr, up to 1 MiB. Longer output keeps its first and last 512 KiB around an omission marker.",
  }),
  truncated: Type.Boolean({ description: "Whether `output` omits part of the command output" }),
  full_output_path: Type.Optional(Type.String({ description: "The log file with the complete output, when truncated" })),
  exit_code: Type.Optional(Type.Number({ description: "Absent while the command is still running in the background" })),
  wall_time_seconds: Type.Number(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("failed"),
    Type.Literal("killed"),
    Type.Literal("orphaned"),
  ]),
  job_id: Type.String({ description: "Pass to shell_status to collect or check a running command" }),
});

export type BashStructured = Static<typeof bashOutputSchema>;

/** Build the structured value for a job from its full log; `now` only matters while it runs. */
export function buildStructured(job: Job, full: FullOutput, now: number = Date.now()): BashStructured {
  const end = job.endedAt ?? now;
  return {
    output: full.content,
    truncated: full.truncated,
    ...(full.truncated ? { full_output_path: job.logPath } : {}),
    ...(job.status !== "running" && typeof job.exitCode === "number" ? { exit_code: job.exitCode } : {}),
    wall_time_seconds: Math.round(Math.max(0, end - job.startedAt) / 100) / 10,
    status: job.status,
    job_id: job.id,
  };
}
