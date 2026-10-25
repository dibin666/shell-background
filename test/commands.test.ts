import { test } from "node:test";
import assert from "node:assert/strict";
import { completeShellBg, matchesJob, parseShellBgArgs, shellBgArgument, sortJobs, wantsFollowUpCompletion } from "../src/commands.ts";
import type { Job, JobStatus } from "../src/types.ts";

function job(id: string, status: JobStatus, command: string, startedAt: number): Job {
  return {
    id,
    command,
    cwd: "/tmp",
    pid: 1,
    status,
    exitCode: status === "done" ? 0 : null,
    signal: null,
    logPath: `/tmp/${id}.log`,
    startedAt,
    endedAt: status === "running" ? null : startedAt + 1000,
    auto: false,
    delivered: false,
  };
}

const jobs = [
  job("bg-1", "done", "ls -la", 1000),
  job("bg-2", "running", "npm run dev", 2000),
  job("bg-3", "failed", "npm test", 3000),
  job("bg-12", "running", "cargo build --release", 4000),
];

test("an empty argument offers every subcommand", () => {
  const items = completeShellBg("", jobs)!;
  assert.deepEqual(
    items.map((i) => i.label),
    ["tui", "status", "kill", "list"],
  );
  assert.ok(items.every((i) => i.value.endsWith(" ")), "a verb completes with a trailing space, ready for the id");
});

test("a partial subcommand narrows the verbs", () => {
  assert.deepEqual(completeShellBg("st", jobs)!.map((i) => i.value), ["status "]);
  assert.deepEqual(completeShellBg("t", jobs)!.map((i) => i.value), ["tui "]);
  assert.deepEqual(completeShellBg("k", jobs)!.map((i) => i.value), ["kill "]);
  assert.equal(completeShellBg("zzz", jobs), null);
});

test("kill completes only running jobs, newest first", () => {
  const items = completeShellBg("kill ", jobs)!;
  assert.deepEqual(items.map((i) => i.value), ["kill bg-12", "kill bg-2"]);
  assert.match(items[0]!.label, /⟳ bg-12/);
  assert.match(items[0]!.description!, /running · cargo build/);
});

test("status completes every job, with its status icon", () => {
  const items = completeShellBg("status ", jobs)!;
  assert.deepEqual(items.map((i) => i.value), ["status bg-12", "status bg-3", "status bg-2", "status bg-1"]);
  assert.deepEqual(items.map((i) => i.label.split(" ")[0]), ["⟳", "✗", "⟳", "✓"]);
});

test("a job completion filters by id or by command", () => {
  assert.deepEqual(completeShellBg("status bg-1", jobs)!.map((i) => i.value), ["status bg-12", "status bg-1"]);
  assert.deepEqual(completeShellBg("status npm", jobs)!.map((i) => i.value), ["status bg-3", "status bg-2"]);
  assert.deepEqual(completeShellBg("kill npm", jobs)!.map((i) => i.value), ["kill bg-2"], "kill never offers a finished job");
  assert.equal(completeShellBg("kill ls", jobs), null);
});

test("nothing is offered once the id is complete, or for an unknown verb", () => {
  assert.equal(completeShellBg("status bg-1 ", jobs), null);
  assert.equal(completeShellBg("list ", jobs), null);
  assert.equal(completeShellBg("nope ", jobs), null);
});

test("parseShellBgArgs maps every form to its action", () => {
  assert.deepEqual(parseShellBgArgs(""), { kind: "none" });
  assert.deepEqual(parseShellBgArgs(undefined), { kind: "none" });
  assert.deepEqual(parseShellBgArgs(" tui "), { kind: "browse" });
  assert.deepEqual(parseShellBgArgs("status"), { kind: "browse" });
  assert.deepEqual(parseShellBgArgs(" status  bg-4 "), { kind: "status", id: "bg-4" });
  assert.deepEqual(parseShellBgArgs("bg-4"), { kind: "status", id: "bg-4" });
  assert.deepEqual(parseShellBgArgs("kill"), { kind: "pick-kill" });
  assert.deepEqual(parseShellBgArgs("kill bg-2"), { kind: "kill", id: "bg-2" });
  assert.deepEqual(parseShellBgArgs("list"), { kind: "list" });
  assert.deepEqual(parseShellBgArgs("frob"), { kind: "unknown", verb: "frob" });
});

test("matchesJob and sortJobs", () => {
  assert.ok(matchesJob(jobs[3]!, "CARGO"));
  assert.ok(matchesJob(jobs[3]!, "12"));
  assert.ok(!matchesJob(jobs[0]!, "npm"));
  assert.ok(matchesJob(jobs[0]!, "  "));
  assert.deepEqual(sortJobs(jobs).map((j) => j.id), ["bg-12", "bg-3", "bg-2", "bg-1"]);
});

test("shellBgArgument and wantsFollowUpCompletion read the editor line", () => {
  assert.equal(shellBgArgument("/shell-bg kill b"), "kill b");
  assert.equal(shellBgArgument("/shell-bg "), "");
  assert.equal(shellBgArgument("/shell-bg"), null, "still typing the command name");
  assert.equal(shellBgArgument("/shell-bgx kill"), null);
  assert.equal(shellBgArgument("say /shell-bg kill"), null);
  for (const t of ["/shell-bg ", "/shell-bg kill ", "/shell-bg status "]) assert.ok(wantsFollowUpCompletion(t), t);
  for (const t of ["/shell-bg kill bg-1", "/shell-bg list ", "/shell-bg kill", "/shell-bg"]) assert.ok(!wantsFollowUpCompletion(t), t);
});
