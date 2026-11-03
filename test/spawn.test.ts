import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawnToFile } from "../src/spawn.ts";
import { readTail } from "../src/tail.ts";
import { killTree } from "../src/kill.ts";

/** Resolve a real shell the same way the extension does. */
function shell(): { shell: string; args: string[] } {
  const c = getShellConfig();
  return { shell: c.shell, args: c.commandTransport === "stdin" ? ["-c"] : [...c.args] };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("spawnToFile writes output to the log and resolves the exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-spawn-"));
  try {
    const log = join(dir, "l.log");
    const { shell: sh, args } = shell();
    const s = spawnToFile(sh, args, "printf 'hello\\nworld\\n'", dir, process.env, log);
    assert.ok(s.pid && s.pid > 0, "has a pid");
    const { code } = await s.exit;
    assert.equal(code, 0);
    await sleep(50);
    assert.match(readTail(log, 65536).text, /hello\nworld/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long command keeps running until the tree is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-kill-"));
  try {
    const log = join(dir, "l.log");
    const { shell: sh, args } = shell();
    // A bounded sleep, not `sleep 30`: if a platform's tree-kill is slow the
    // child still self-terminates soon after, so the test runner can always
    // exit instead of hanging on an orphaned process (Windows+bun flake).
    const s = spawnToFile(sh, args, "sleep 8", dir, process.env, log);
    let exited = false;
    void s.exit.then(() => {
      exited = true;
    });
    await sleep(300);
    assert.equal(exited, false, "still running after 300ms");
    killTree(s.pid);
    // Cancelable race timer so the losing branch never keeps the event loop
    // alive after the winner resolves.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((r) => {
      timer = setTimeout(() => r("timeout"), 5000);
    });
    const outcome = await Promise.race([s.exit.then(() => "exited"), timeout]);
    clearTimeout(timer);
    assert.equal(outcome, "exited", "killTree terminated the command");
    // Reap the child before leaving the test so the runner is not left waiting
    // on a live process handle.
    await s.exit.catch(() => {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killTree is a safe no-op on invalid pids", () => {
  assert.doesNotThrow(() => {
    killTree(0);
    killTree(null);
    killTree(undefined);
    killTree(-5);
  });
});

test("the log is complete the moment exit resolves, even after a burst of output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbg-flush-"));
  try {
    const { shell: sh, args } = shell();
    // Before the fix, about 1 run in 5 read here lost its tail: exit resolved
    // while the last writes were still queued in the log's write stream.
    for (let i = 0; i < 20; i++) {
      const log = join(dir, `l${i}.log`);
      const s = spawnToFile(sh, args, "seq 1 50000; echo END-MARKER", dir, process.env, log);
      await s.exit; // no sleep: whatever reads the log at settle time must see it all
      const text = readTail(log, 1024 * 1024).text;
      assert.ok(text.trimEnd().endsWith("END-MARKER"), `run ${i}: log ends with ${JSON.stringify(text.slice(-20))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
