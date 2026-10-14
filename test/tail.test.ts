import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTail, countLines, DEFAULT_TAIL_BYTES } from "../src/tail.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sbg-tail-"));
}

test("readTail returns the whole file when it fits", () => {
  const dir = tmp();
  try {
    const f = join(dir, "log");
    writeFileSync(f, "hello\nworld\n");
    const t = readTail(f, DEFAULT_TAIL_BYTES);
    assert.equal(t.text, "hello\nworld\n");
    assert.equal(t.truncated, false);
    assert.equal(t.bytes, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTail bounds the window and reports truncation", () => {
  const dir = tmp();
  try {
    const f = join(dir, "log");
    writeFileSync(f, "0123456789");
    const t = readTail(f, 4);
    assert.equal(t.text, "6789");
    assert.equal(t.truncated, true);
    assert.equal(t.bytes, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTail drops a leading partial UTF-8 char at the cut", () => {
  const dir = tmp();
  try {
    const f = join(dir, "log");
    // bytes: 'a', 0xC3 0xA9 ('é'), 'b'  → 4 bytes total
    writeFileSync(f, Buffer.from([0x61, 0xc3, 0xa9, 0x62]));
    // window of last 2 bytes starts on the 0xA9 continuation byte → dropped.
    const t = readTail(f, 2);
    assert.equal(t.text, "b");
    assert.equal(t.truncated, true);
    // whole file decodes the multibyte char intact
    assert.equal(readTail(f, 100).text, "aéb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTail on a missing file is empty and says so; an unreadable log is not a silent command", () => {
  assert.deepEqual(readTail("/no/such/file/xyz", 100), { text: "", truncated: false, bytes: 0, missing: true });
});

test("countLines ignores blank lines", () => {
  assert.equal(countLines("a\n\nb\n"), 2);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("   \n\t\n"), 0);
});
