import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseCarriageReturns, isImportantLine, shrinkLines } from "../src/shrink.ts";
import { sanitizeOutput } from "../src/sanitize.ts";

test("a carriage-return redraw keeps only the last frame; CRLF lines keep their content", () => {
  assert.equal(collapseCarriageReturns("10%\r20%\r100% done\nnext"), "100% done\nnext");
  assert.equal(collapseCarriageReturns("a\r\nb\r\n"), "a\nb\n");
  assert.equal(collapseCarriageReturns("plain\ntext"), "plain\ntext");
  // Through the real sanitizer, with the erase-line escape a progress bar emits.
  const frames = Array.from({ length: 2000 }, (_, i) => `\u001b[2K\r${i}/2000`).join("") + "\n";
  assert.equal(sanitizeOutput(frames), "1999/2000\n");
});

test("important lines are the ones that name trouble", () => {
  for (const line of ["error TS2304: Cannot find name", "FAILED tests/x.py::test_a", "Traceback (most recent call last):", "    at foo (a.js:1:2)", '  File "x.py", line 3', "src/a.ts:12:5: unused var", "AssertionError: 1 != 2", "java.lang.NullPointerException", "Caused by: boom", "exit status 1", "[… 5 lines omitted …]"]) {
    assert.ok(isImportantLine(line), line);
  }
  for (const line of ["info: compiled 3 files", "terror at the gates", "ok 1 - thing", "exit status 0", "  3 passed"]) {
    assert.ok(!isImportantLine(line), line);
  }
});

test("shrinkLines keeps head, tail and every important line, and collapses the rest into counted markers", () => {
  const body = Array.from({ length: 400 }, (_, i) => (i === 150 ? "ERROR: step 7 failed" : i % 10 === 0 ? `DEBUG tick ${i}` : `INFO line ${i}`));
  const { text, omitted, total } = shrinkLines(body.join("\n"), { head: 3, tail: 10, maxLines: 50 });
  const lines = text.split("\n");
  assert.equal(total, 400);
  assert.ok(omitted > 300 && omitted < 400, String(omitted));
  assert.deepEqual(lines.slice(0, 3), body.slice(0, 3));
  assert.deepEqual(lines.slice(-10), body.slice(-10));
  assert.ok(lines.includes("ERROR: step 7 failed"), "the error in the middle survived");
  const markers = lines.filter((l) => l.startsWith("[… "));
  assert.equal(markers.length, 2, "one marker either side of the kept error");
  assert.match(markers[0]!, /^\[… \d+ lines omitted \(INFO ×\d+, DEBUG ×\d+\) …\]$/);
  // The counts are facts about exactly the replaced lines.
  const counted = markers.map((m) => [...m.matchAll(/×(\d+)/g)].reduce((s, x) => s + Number(x[1]), 0)).reduce((a, b) => a + b, 0);
  assert.equal(counted, omitted);
});

test("a short text is untouched; runs under 3 lines are never replaced by a marker; the pass is a fixed point", () => {
  const short = "a\nb\nc";
  assert.equal(shrinkLines(short, { maxLines: 2 }).text, short, "head keeps a text shorter than head+tail");
  assert.equal(shrinkLines(short, { maxLines: 200 }).text, short);
  assert.equal(shrinkLines("x\n".repeat(300), { maxLines: 0 }).omitted, 0, "0 disables");
  // Important lines every other line: no run reaches 3, nothing is elided.
  const dense = Array.from({ length: 30 }, (_, i) => (i % 2 ? `ERROR ${i}` : `line ${i}`)).join("\n");
  assert.equal(shrinkLines(dense, { head: 1, tail: 1, maxLines: 5 }).omitted, 0);
  const once = shrinkLines(Array.from({ length: 500 }, (_, i) => `INFO ${i}`).join("\n"), { head: 3, tail: 10, maxLines: 50 });
  const twice = shrinkLines(once.text, { head: 3, tail: 10, maxLines: 50 });
  assert.equal(twice.text, once.text, "shrinking a shrunk text is byte-identical");
  assert.equal(twice.omitted, 0);
});
