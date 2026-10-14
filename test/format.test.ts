import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { header, formatResult, formatList } from "../src/format.ts";
import type { Job } from "../src/types.ts";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "bg-1",
    command: "npm test",
    cwd: "/x",
    pid: 123,
    status: "done",
    exitCode: 0,
    signal: null,
    logPath: "/no/log",
    startedAt: 1000,
    endedAt: 5200,
    auto: false,
    delivered: false,
    ...over,
  };
}

test("header states id, status, verdict and duration", () => {
  assert.match(header(job()), /^\[bg-1 · done · exit 0 · 4\.2s\]$/);
  assert.match(header(job({ status: "failed", exitCode: 1 })), /failed · exit 1/);
  assert.match(header(job({ status: "killed", exitCode: null, signal: "SIGKILL" })), /killed · signal SIGKILL/);
  assert.match(header(job({ status: "running", endedAt: null, exitCode: null })), /^\[bg-1 · running · [^·]+\]$/, "no verdict while running");
});

test("formatResult shows the header and the output tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "l.log");
    writeFileSync(logPath, "line one\nline two\n");
    const text = formatResult(job({ logPath }), 65536);
    assert.match(text, /\[bg-1 · done · exit 0/);
    assert.match(text, /line one\nline two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatResult is honest about no output, and about a log it cannot read", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "empty.log");
    writeFileSync(logPath, "");
    assert.match(formatResult(job({ logPath }), 65536), /\(no output\)/);
    assert.match(formatResult(job({ logPath, status: "running", endedAt: null }), 65536), /\(no output yet\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A missing log is not a command that printed nothing.
  assert.match(formatResult(job({ logPath: "/no/such" }), 65536), /\(log unavailable: \/no\/such could not be read\)/);
});

test("formatResult shrinks a long log by lines, keeps the error in the middle, and says what it left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-fmt-"));
  try {
    const logPath = join(dir, "build.log");
    const body = Array.from({ length: 600 }, (_, i) => (i === 300 ? "error TS2304: Cannot find name 'x'" : `INFO step ${i}`));
    writeFileSync(logPath, body.join("\n") + "\n");
    const text = formatResult(job({ logPath }), 65536, 200);
    assert.match(text, /error TS2304/, "the failing step survived in the middle");
    assert.match(text, /^… \d+ of 600 lines omitted, none with an error or warning .* — full log: /m);
    assert.match(text, /\[… \d+ lines omitted \(INFO ×\d+\) …\]/);
    assert.ok(text.includes("INFO step 599"), "the tail is there");
    assert.ok(text.includes("INFO step 0"), "the head is there");
    assert.ok(text.split("\n").length < 260, "well under the untouched 600");
    // tailLines 0 turns shrinking off.
    assert.ok(formatResult(job({ logPath }), 65536, 0).split("\n").length > 600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatList summarizes running vs total, newest first", () => {
  const jobs = [
    job({ id: "bg-1", status: "done", startedAt: 1 }),
    job({ id: "bg-2", status: "running", endedAt: null, startedAt: 2 }),
  ];
  const list = formatList(jobs);
  assert.match(list, /1 running, 2 total/);
  assert.ok(list.indexOf("bg-2") < list.indexOf("bg-1"), "newest first");
  assert.match(formatList([]), /No background commands/);
});
