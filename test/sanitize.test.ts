import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeOutput, stripAnsi } from "../src/sanitize.ts";
import { formatResult } from "../src/format.ts";
import type { Job } from "../src/types.ts";

test("stripAnsi removes CSI colour codes and OSC hyperlinks, leaves plain text alone", () => {
  assert.equal(stripAnsi("\u001B[32mPASS\u001B[0m ok"), "PASS ok");
  assert.equal(stripAnsi("\u001B]8;;https://x.test\u0007link\u001B]8;;\u0007"), "link");
  assert.equal(stripAnsi("plain"), "plain");
});

test("sanitizeOutput matches pi's bash (no ANSI, no control chars) but resolves a \r redraw to its last frame", () => {
  const raw = "\u001B[1mBuilding\u001B[0m 10%\r20%\r100%\r\n\u0007done\u0000\n";
  // pi's own cleaning would hand the model "Building 10%20%100%": three frames glued together.
  assert.equal(sanitizeOutput(raw), "100%\ndone\n");
  // tab and newline survive
  assert.equal(sanitizeOutput("a\tb\n"), "a\tb\n");
});

test("formatResult hands the model a cleaned tail while the log on disk keeps every byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-san-"));
  try {
    const logPath = join(dir, "l.log");
    const raw = "\u001B[33mwarn\u001B[0m first\r\n\u001B[2K\rprogress 100%\n";
    writeFileSync(logPath, raw);
    const job: Job = {
      id: "bg-1", command: "npm run build", cwd: "/x", pid: 1, status: "done", exitCode: 0, signal: null,
      logPath, startedAt: 0, endedAt: 10, auto: false, delivered: false,
    };
    const text = formatResult(job, 65536);
    assert.ok(!text.includes("\u001B"), text);
    assert.ok(!text.includes("\r"), text);
    assert.ok(text.endsWith("warn first\nprogress 100%"), text);
    assert.equal(readFileSync(logPath, "utf8"), raw, "the on-disk log is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
