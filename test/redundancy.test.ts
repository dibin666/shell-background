import { test } from "node:test";
import assert from "node:assert/strict";
import { keepNonRedundant } from "../src/redundancy.ts";
import { shrinkLines } from "../src/shrink.ts";

test("an identical repeated line elides, but a distinct line keeps a representative", () => {
  const units = ["Downloading pkg... done", "Downloading pkg... done", "Downloading pkg... done", "SURPRISE unique fact appears", "Downloading pkg... done", "Downloading pkg... done"];
  const keep = units.map(() => false);
  keepNonRedundant(units, keep);
  assert.equal(keep[0], true, "the first repeat represents the class");
  assert.equal(keep[3], true, "the distinct line is never dropped");
  assert.equal(keep[1], false, "a later identical line elides against the first");
  assert.equal(keep[4], false);
});

test("timestamps and row ids mask out, so lines differing only in numbers are one class", () => {
  const units = [
    "2026-01-01T10:00:00 INFO request handled in 12ms",
    "2026-01-01T10:00:01 INFO request handled in 9ms",
    "2026-01-01T10:00:02 INFO request handled in 44ms",
  ];
  const keep = [true, false, false];
  keepNonRedundant(units, keep);
  assert.deepEqual(keep, [true, false, false], "the two later lines mask to the same class and elide");
});

test("numbers are the content when a line has no words: distinct value rows do not collapse", () => {
  const units = ["1973 251", "1974 260", "1975 280"];
  const keep = [true, false, false];
  keepNonRedundant(units, keep);
  assert.deepEqual(keep, [true, true, true], "no word tokens, so digits stay and each row is distinct");
});

// A unique letter-only token per n (binary digits mapped to x/y), so digit masking cannot merge them.
const alpha = (n: number): string => "w" + (n.toString(2).split("").map((b) => (b === "1" ? "x" : "y")).join(""));

test("a document of genuinely distinct lines (under the promotion cap) is kept wholesale", () => {
  const units = Array.from({ length: 100 }, (_, i) => `the ${alpha(i)} theorem proves ${alpha(i + 500)}`);
  const keep = units.map((_, i) => i < 3 || i >= 98);
  keepNonRedundant(units, keep);
  assert.equal(keep.filter(Boolean).length, 100, "every line has a unique word token, so all are kept");
});

test("shrinkLines keeps a distinct-word document; it still collapses an identical-line stream", () => {
  const distinct = Array.from({ length: 120 }, (_, i) => `step ${alpha(i)} ran ${alpha(i + 999)}`).join("\n");
  const d = shrinkLines(distinct, { head: 3, tail: 10, maxLines: 50 });
  assert.equal(d.omitted, 0, "a document of unique lines is not truncated");
  const repetitive = Array.from({ length: 400 }, () => "Downloading package... done").join("\n");
  const r = shrinkLines(repetitive, { head: 3, tail: 10, maxLines: 50 });
  assert.ok(r.omitted > 350, `a repeated identical line collapses hard, omitted=${r.omitted}`);
});
