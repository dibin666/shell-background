/**
 * Regression tests that drive the extension itself (not just the src/ helpers)
 * through a minimal mock of the pi ExtensionAPI. They pin two bugs:
 *
 *  1. Polling a still-running job with shell_status must not set delivered=true,
 *     which would permanently cancel the promised auto-delivery.
 *  3. A timeout the caller passed must still fire after a command auto-moves to
 *     the background — the kill the model expects may not be silently dropped.
 *
 * Both spawn a real, short-lived shell command, so they use the same portable
 * pipe→file spawn path the extension does (no numeric-fd stdio; Windows-safe).
 * Every spawned command is torn down before the test returns so the test runner
 * never blocks on a lingering child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import shellBackground from "../extensions/shell-background.ts";
import { DELIVERY_TYPE } from "../src/pending.ts";

type AnyTool = { name: string; execute: (...a: any[]) => Promise<any> };
type AnyHandler = (event: any, ctx: any) => any;

interface Harness {
  pi: ExtensionAPI;
  tools: Map<string, AnyTool>;
  handlers: Map<string, AnyHandler>;
  sent: any[];
}

function harness(): Harness {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, AnyHandler>();
  const sent: any[] = [];
  const pi = {
    registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: AnyHandler) => handlers.set(event, handler),
    sendMessage: (msg: unknown) => sent.push(msg),
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers, sent };
}

function makeCtx(cwd: string, hasUI: boolean, sessionId?: string): ExtensionContext {
  return {
    cwd,
    hasUI,
    // The registry keys off the session id (stable across /reload); the unit
    // tests supply one so a session survives a simulated reload the way it does
    // in a real host, where PI_SESSION_ID is never on the host's own env.
    sessionManager: sessionId
      ? { getSessionId: () => sessionId, getSessionFile: () => undefined }
      : undefined,
    model: undefined,
    ui: {
      setWidget: () => {},
      notify: () => {},
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Remove a dir, retrying on Windows EBUSY: a just-killed child still briefly
 * locks its own cwd / log file, so the first rm can race the taskkill.
 */
async function rmDir(p: string): Promise<void> {
  for (let i = 0; i < 25; i++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met in time");
    await sleep(25);
  }
}

/** A unique, filesystem-safe session id so each test gets its own registry dir. */
function uniqueSession(): { id: string; regDir: string } {
  const id = `sbgtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, regDir: join(tmpdir(), "pify-shell-bg", id) };
}

/**
 * Kill every still-running job and wait until nothing runs, so no child process
 * outlives the test and blocks the runner from exiting.
 */
async function teardown(h: Harness, ctx: ExtensionContext): Promise<void> {
  const shutdown = h.handlers.get("session_shutdown");
  if (shutdown) await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  const status = h.tools.get("shell_status");
  if (!status) return;
  await waitFor(async () => {
    const list = await status.execute("teardown", {});
    return /^0 running/.test(String(list.content[0].text));
  }, 8000).catch(() => {});
}

test("polling a running job does not cancel its auto-delivery (bug #1)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext1-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    // Launch a background command that takes ~2s to finish.
    const started = await bash.execute("t1", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;
    assert.ok(jobId, "the launch returned a job id");

    // Poll it while it is still running — this must NOT mark it delivered.
    const polled = await shellStatus.execute("t2", { id: jobId });
    assert.equal(polled.details.status, "running", "job is still running when polled");
    assert.equal(h.sent.length, 0, "nothing delivered while still running");

    // Delivery must still fire when it finishes, because the poll did not cancel
    // it. (Before the fix, the poll set delivered=true and this never arrives, so
    // this waitFor times out and the test fails.)
    await waitFor(() => h.sent.length > 0, 6000);
    assert.equal(h.sent.length, 1, "the finished job was auto-delivered exactly once");
    assert.equal(h.sent[0].customType, DELIVERY_TYPE);
    assert.equal(h.sent[0].details.id, jobId);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("maxBackground: an explicit background request over the cap is refused, not the command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-cap1-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ maxBackground: 1 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;

    const first = await bash.execute("t1", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    assert.ok(first.details.id, "the first background job starts");

    const second = await bash.execute("t2", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    assert.equal(second.isError, true, "the second background request is refused");
    assert.match(String(second.content[0].text), /maxBackground = 1/);
    assert.equal(second.details.limit, 1);

    // The same command still runs in the foreground: the cap never refuses execution.
    const fg = await bash.execute("t3", { command: "echo still-runs" }, undefined, undefined, ctx);
    assert.notEqual(fg.isError, true);
    assert.match(String(fg.content[0].text), /still-runs/);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("maxBackground: over the cap a long foreground command stays in the foreground instead of auto-backgrounding", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-cap2-"));
  const { id: sid, regDir } = uniqueSession();
  const prevMs = process.env.PIFY_SHELL_BG_MS;
  process.env.PIFY_SHELL_BG_MS = "200";
  const h = harness();
  const ctx = makeCtx(cwd, true, sid);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "shell-background.json"), JSON.stringify({ maxBackground: 1 }));
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;

    const parked = await bash.execute("t1", { command: "sleep 3", background: true }, undefined, undefined, ctx);
    assert.ok(parked.details.id);

    // Outlives the 200ms threshold, but the cap is full: it must NOT move to the
    // background — it runs to completion in the foreground and says why.
    const res = await bash.execute("t2", { command: "sleep 1" }, undefined, undefined, ctx);
    assert.equal(res.details.background, false, "not backgrounded");
    assert.equal(res.details.status, "done");
    assert.match(String(res.content[0].text), /kept in the foreground/);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
    if (prevMs === undefined) delete process.env.PIFY_SHELL_BG_MS;
    else process.env.PIFY_SHELL_BG_MS = prevMs;
  }
});

test("a timeout still fires after a command auto-backgrounds (bug #3)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-ext3-"));
  const { id: sid, regDir } = uniqueSession();
  const prevMs = process.env.PIFY_SHELL_BG_MS;
  // Move to the background quickly so the test does not wait the default 30s.
  process.env.PIFY_SHELL_BG_MS = "200";
  const h = harness();
  const ctx = makeCtx(cwd, true, sid); // hasUI so auto-background is enabled
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const bash = h.tools.get("bash")!;
    const shellStatus = h.tools.get("shell_status")!;

    // A command with a 1s timeout that outlives both the 200ms auto-background
    // threshold and the timeout: it must auto-background, then the timeout must
    // survive that move and kill it around the 1s mark (well before it would end
    // on its own).
    const res = await bash.execute("t1", { command: "sleep 3", timeout: 1 }, undefined, undefined, ctx);
    assert.equal(res.details.background, true, "the command was moved to the background");
    const jobId = res.details.id as string;

    // Before the fix the timeout is dropped, so it is still "running" past the
    // 1s deadline; after the fix the surviving timeout kills it.
    await waitFor(async () => (await shellStatus.execute("p", { id: jobId })).details.status !== "running", 6000);
    const final = await shellStatus.execute("f", { id: jobId });
    assert.equal(final.details.status, "killed", "the surviving timeout killed the backgrounded job");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
    if (prevMs === undefined) delete process.env.PIFY_SHELL_BG_MS;
    else process.env.PIFY_SHELL_BG_MS = prevMs;
  }
});

test("a /reload hands jobs to the new instance, which delivers exactly once (finding f071/f078)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-reload-"));
  const { id: sid, regDir } = uniqueSession();
  const a = harness();
  const b = harness();
  const ctxA = makeCtx(cwd, false, sid);
  const ctxB = makeCtx(cwd, false, sid);
  try {
    // Instance A starts and launches a background command that runs a few seconds.
    shellBackground(a.pi);
    await a.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctxA);
    const started = await a.tools
      .get("bash")!
      .execute("t1", { command: "sleep 3", background: true }, undefined, undefined, ctxA);
    const jobId = started.details.id as string;
    assert.ok(jobId);

    // /reload: shut A down with reason "reload" (this must NOT kill the job) then
    // stand up a fresh instance B over the same registry dir with reason "reload".
    await a.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctxA);
    shellBackground(b.pi);
    await b.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctxB);

    const statusB = b.tools.get("shell_status")!;
    // B adopts the handed-off job while it is still running...
    const early = await statusB.execute("s1", { id: jobId });
    assert.equal(early.details.status, "running", "B adopts the job as still running");

    // ...and delivers it exactly once, through B's own pi, when it finishes.
    await waitFor(() => b.sent.length > 0, 8000);
    assert.equal(b.sent.length, 1, "B delivered the finished job exactly once");
    assert.equal(b.sent[0].customType, DELIVERY_TYPE);
    assert.equal(b.sent[0].details.id, jobId);

    const late = await statusB.execute("s2", { id: jobId });
    assert.notEqual(late.details.status, "running", "B now shows the job finished");

    // The old instance A must stay silent: had it delivered, or (before the fix)
    // marked the sidecar delivered before its stale send threw, B would never
    // have delivered and the assertion above would have failed. Pin it directly.
    assert.equal(a.sent.length, 0, "the old instance A delivered nothing");
  } finally {
    await teardown(b, ctxB);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("a handed-off instance flushes final status without marking it delivered (finding f071)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-handoff-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const started = await h.tools
      .get("bash")!
      .execute("t1", { command: "sleep 1", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // Reload hand-off, but no new instance is started here. The old closures are
    // still alive in-process; when the command ends they must persist the final
    // status but NOT deliver and NOT flip delivered (which would have stranded a
    // real successor). Wait past the command's runtime, then read the sidecar.
    await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx);
    await sleep(2500);

    const sidecar = JSON.parse(readFileSync(join(regDir, `${jobId}.json`), "utf8"));
    assert.notEqual(sidecar.status, "running", "the old instance flushed a final status");
    assert.equal(sidecar.delivered, false, "but did not mark it delivered");
    assert.equal(h.sent.length, 0, "and delivered nothing through the stale pi");
  } finally {
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("quit kills a running job and records it killed (finding f078 complement)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-quit-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const started = await h.tools
      .get("bash")!
      .execute("t1", { command: "sleep 30", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    // A quit shutdown ends the session for good: it must kill the tree and record
    // "killed" synchronously so a later reader never sees a dead job as running.
    await h.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    const status = await h.tools.get("shell_status")!.execute("s", { id: jobId });
    assert.equal(status.details.status, "killed", "the quit-killed job is recorded killed");
    assert.equal(existsSync(regDir), false, "and the session's registry dir is cleaned up");
  } finally {
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("the bash guideline is headless-aware, not a false auto-background promise (finding f073)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-hl-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid); // headless: no UI to deliver into
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")! as unknown as { promptGuidelines: string[] };
    const last = bash.promptGuidelines.at(-1) ?? "";
    assert.match(last, /headless/i, "the guideline says it is a headless run");
    assert.doesNotMatch(last, /moved to the background/i, "no false auto-background promise");
    assert.doesNotMatch(last, /after 0s/i, "no 'after 0s' nonsense");
  } finally {
    const sd = h.handlers.get("session_shutdown");
    if (sd) await sd({ type: "session_shutdown", reason: "quit" }, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("with auto-background disabled the guideline does not say 'after 0s' (finding f073)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-zero-"));
  const { id: sid, regDir } = uniqueSession();
  const prevMs = process.env.PIFY_SHELL_BG_MS;
  process.env.PIFY_SHELL_BG_MS = "0"; // auto-background disabled
  const h = harness();
  const ctx = makeCtx(cwd, true, sid); // interactive, but threshold is 0
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")! as unknown as { promptGuidelines: string[] };
    const last = bash.promptGuidelines.at(-1) ?? "";
    assert.doesNotMatch(last, /after 0s/i, "no 'after 0s' promise");
    assert.doesNotMatch(last, /moved to the background/i, "and no auto-background claim");
    assert.match(last, /run to completion/i, "it says commands run to completion");
  } finally {
    const sd = h.handlers.get("session_shutdown");
    if (sd) await sd({ type: "session_shutdown", reason: "quit" }, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
    if (prevMs === undefined) delete process.env.PIFY_SHELL_BG_MS;
    else process.env.PIFY_SHELL_BG_MS = prevMs;
  }
});

test("shell_status wait blocks until a running job finishes (finding f075)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-wait-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const started = await h.tools
      .get("bash")!
      .execute("t1", { command: "sleep 1", background: true }, undefined, undefined, ctx);
    const jobId = started.details.id as string;

    const t0 = Date.now();
    const res = await h.tools.get("shell_status")!.execute("w", { id: jobId, wait: 10 });
    assert.notEqual(res.details.status, "running", "wait blocked until the job finished");
    assert.ok(Date.now() - t0 >= 500, "and it actually waited for it");
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});

test("pi 0.99: results carry structuredContent for scripts — exit_code once finished, absent while running", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sbg-struct-"));
  const { id: sid, regDir } = uniqueSession();
  const h = harness();
  const ctx = makeCtx(cwd, false, sid);
  try {
    shellBackground(h.pi);
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const bash = h.tools.get("bash")!;
    assert.ok((bash as { outputSchema?: unknown }).outputSchema, "the tool declares its outputSchema");

    const done = await bash.execute("t1", { command: "echo structured-ok" }, undefined, undefined, ctx);
    const sc = done.structuredContent as { output: string; exit_code?: number; status: string; job_id: string; truncated: boolean };
    assert.match(sc.output, /structured-ok/);
    assert.equal(sc.exit_code, 0);
    assert.equal(sc.status, "done");
    assert.equal(sc.truncated, false);
    assert.match(sc.job_id, /^bg-/);

    const bg = await bash.execute("t2", { command: "sleep 2", background: true }, undefined, undefined, ctx);
    const running = bg.structuredContent as { status: string; exit_code?: number; job_id: string };
    assert.equal(running.status, "running");
    assert.equal("exit_code" in running, false);
    const status = h.tools.get("shell_status")!;
    await waitFor(async () => (await status.execute("p", { id: running.job_id })).details.status !== "running", 6000);
    const collected = await status.execute("c", { id: running.job_id });
    assert.equal((collected.structuredContent as { exit_code?: number }).exit_code, 0);
  } finally {
    await teardown(h, ctx);
    await rmDir(cwd);
    await rmDir(regDir);
  }
});
