import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFull } from "../src/tail.ts";
import { buildStructured } from "../src/structured.ts";
import type { Job } from "../src/types.ts";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "bg-1", command: "npm test", cwd: "/x", pid: 123, status: "done", exitCode: 0, signal: null,
    logPath: "/no/log", startedAt: 1000, endedAt: 5200, auto: false, delivered: false, ...over,
  };
}

test("readFull returns the whole log when it fits and keeps head and tail around a marker when it does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-full-"));
  try {
    const small = join(dir, "s.log");
    writeFileSync(small, "hello\nworld\n");
    assert.deepEqual(readFull(small, 1024), { content: "hello\nworld\n", truncated: false, bytes: 12 });
    const big = join(dir, "b.log");
    writeFileSync(big, `${"A".repeat(600)}é${"B".repeat(600)}`);
    const full = readFull(big, 400);
    assert.equal(full.truncated, true);
    assert.match(full.content, /^A{200}\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\nB{200}$/);
    assert.equal(readFull(join(dir, "missing.log"), 10).content, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildStructured mirrors pi's bash fields and adds status and job_id; exit_code is absent while running", () => {
  const done = buildStructured(job(), { content: "out", truncated: false, bytes: 3 });
  assert.deepEqual(done, { output: "out", truncated: false, exit_code: 0, wall_time_seconds: 4.2, status: "done", job_id: "bg-1" });
  const running = buildStructured(job({ status: "running", exitCode: null, endedAt: null }), { content: "so far", truncated: false, bytes: 6 }, 3000);
  assert.equal(running.status, "running");
  assert.equal("exit_code" in running, false);
  assert.equal(running.wall_time_seconds, 2);
  const cut = buildStructured(job({ status: "failed", exitCode: 1, logPath: "/l/bg-1.log" }), { content: "x", truncated: true, bytes: 9 });
  assert.equal(cut.full_output_path, "/l/bg-1.log");
  assert.equal(cut.exit_code, 1);
});
