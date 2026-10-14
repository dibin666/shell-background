import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestReport, renderTestReport, testCountLine, trimStack } from "../src/testreport.ts";

const pytest = JSON.stringify({
  exitcode: 1,
  duration: 2.5,
  tests: [
    { nodeid: "test_a.py::test_ok", outcome: "passed" },
    { nodeid: "test_a.py::test_bad", outcome: "failed", call: { longrepr: "def test_bad():\n>   assert 1 == 2\nE   assert 1 == 2\ntest_a.py:12: AssertionError" } },
    { nodeid: "test_a.py::test_skip", outcome: "skipped" },
    { nodeid: "test_a.py::test_x", outcome: "xfailed" },
  ],
});

const jest = JSON.stringify({
  numPassedTests: 240,
  numFailedTests: 3,
  numPendingTests: 1,
  testResults: [
    { name: "a.test.ts", assertionResults: [
      { fullName: "adder adds", status: "passed" },
      { ancestorTitles: ["adder"], title: "handles zero", status: "failed", failureMessages: ["Error: expected 0 to be 1\n    at Object.<anonymous> (a.test.ts:4:20)"] },
    ] },
  ],
});

test("pytest JSON becomes counts plus every failure; xfailed is not dropped", () => {
  const r = parseTestReport(pytest)!;
  assert.ok(r);
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 1, 1]);
  assert.equal(r.other.xfailed, 1);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]!.message, "assert 1 == 2");
  const text = renderTestReport(r);
  assert.match(text, /^TEST SUMMARY: 1 passed, 1 failed, 1 skipped, 1 xfailed \(2\.5s\)/);
  assert.match(text, /FAILED: test_a\.py::test_bad/);
  assert.match(text, /test_a\.py:12: AssertionError/);
});

test("jest JSON becomes a summary with the failed assertion and its stack", () => {
  const r = parseTestReport(jest)!;
  assert.deepEqual([r.passed, r.failed, r.skipped], [240, 3, 1]);
  assert.equal(r.failures[0]!.name, "adder › handles zero");
  assert.equal(testCountLine(r), "3 failed, 240 passed, 1 skipped");
  assert.match(renderTestReport(r), /a\.test\.ts:4:20/);
});

test("detection gates on exact top-level keys; ordinary JSON is not a report", () => {
  assert.equal(parseTestReport('{"exitcode":0}'), null, "no tests array");
  assert.equal(parseTestReport('{"numFailedTests":1}'), null, "no testResults array");
  assert.equal(parseTestReport('{"a":{"exitcode":1,"tests":[]}}'), null, "keys nested deeper do not count");
  assert.equal(parseTestReport('{"exitcode":0,"tests":[]}'), null, "zero tests passes through");
  assert.equal(parseTestReport("not json"), null);
  assert.equal(parseTestReport("plain build output\nerror: boom"), null);
});

test("trimStack keeps 3 head + 2 tail only when that drops at least 3, and only real frames", () => {
  const frames = ["message line", "at a (x.ts:1:1)", "at b (x.ts:2:1)", "at c (x.ts:3:1)", "at d (x.ts:4:1)", "at e (x.ts:5:1)", "at f (x.ts:6:1)", "at g (x.ts:7:1)", "at h (x.ts:8:1)"];
  const out = trimStack(frames);
  assert.equal(out.length, 6);
  assert.equal(out[0], "at a (x.ts:1:1)");
  assert.match(out[3]!, /3 frames omitted/);
  assert.equal(out[5], "at h (x.ts:8:1)");
  assert.deepEqual(trimStack(["at a (x.ts:1:1)", "random prose"]), ["at a (x.ts:1:1)"]);
});
