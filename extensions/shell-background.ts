/**
 * @pify/shell-background — long-running bash goes async.
 *
 * Re-registers pi's `bash` tool with the same shell, cwd and env, but a
 * different lifecycle:
 *
 *   - a command's stdout+stderr are written straight to a log file via
 *     inherited file descriptors (no pipes, so no drain deadlock and no lost
 *     output at any volume), the process is spawned detached and unref'd so it
 *     survives the tool returning;
 *   - a foreground command that is still running after the auto-background
 *     threshold (default 30s, interactive sessions only) is moved to the
 *     background: the tool returns "moved to background, id=…" and the result is
 *     delivered into the conversation when the command finishes;
 *   - `background: true` launches detached from the start and returns the id
 *     immediately.
 *
 * `shell_status` polls or collects a job (and lists them all); `shell_kill`
 * terminates one and its whole process tree. Delivery reuses the suite's
 * pending pattern and its one hard rule: it only works in a session that
 * outlives the run, so auto-background is off under headless `pi -p` (explicit
 * background still works, collected with shell_status inside the turn).
 *
 * pi has no native background bash — every command is awaited to completion —
 * so the spawn is our own, reusing pi's shell resolution (getShellConfig) for
 * byte-identical shell behaviour. Zero runtime dependencies.
 */
import {
  createBashToolDefinition,
  getAgentDir,
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";

import { JobRegistry, isAlive } from "../src/registry.ts";
import { spawnToFile } from "../src/spawn.ts";
import { killTree } from "../src/kill.ts";
import { readTail } from "../src/tail.ts";
import { buildEnv } from "../src/env.ts";
import { DEFAULT_SETTINGS, resolveSettings, type ShellBgSettings } from "../src/config.ts";
import { backgroundedResult, deliveryMessage, DELIVERY_TYPE } from "../src/pending.ts";
import { formatResult, formatList, header } from "../src/format.ts";
import { sanitizeOutput } from "../src/sanitize.ts";
import { readFull } from "../src/tail.ts";
import { STRUCTURED_OUTPUT_MAX_BYTES, bashOutputSchema, buildStructured, type BashStructured } from "../src/structured.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { isFinished } from "../src/types.ts";
import type { Job } from "../src/types.ts";

type UiContext = ExtensionContext;
type AnyTool = { name: string; execute: (...a: never[]) => unknown; [k: string]: unknown };
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /** pi 0.99: what codemode scripts and ctx.executeTool() callers receive instead of the text. */
  structuredContent?: BashStructured;
  isError?: boolean;
};

const WIDGET = "shell-bg";

export default function shellBackground(pi: ExtensionAPI) {
  let settings: ShellBgSettings = DEFAULT_SETTINGS;
  let registry: JobRegistry | null = null;
  let lastUiCtx: UiContext | null = null;
  let widgetTimer: NodeJS.Timeout | null = null;
  // Set on a /reload shutdown: this (old) instance's processes are being handed
  // to the next instance in the same host process, so its settle/delivery
  // closures must go quiet — flush status to disk, but never kill and never
  // deliver through the now-stale pi handle. Each instance has its own copy
  // (reload builds a fresh closure), so this only ever flips once, on the way out.
  let handedOff = false;

  const ROOT = join(tmpdir(), "pify-shell-bg");
  const MAX_SESSION_DIR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  // Ref'd on purpose: this backs the shell_status `wait` poll, which is awaited
  // inside an in-flight tool call, so the timer must actually resolve rather than
  // let an otherwise-idle loop exit out from under it.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * The one auto-background threshold, computed once so the bash guideline and
   * runBash cannot drift: auto-background needs a session that outlives the run
   * to deliver into, which a headless `pi -p` does not have, so it is off there.
   */
  const effectiveAutoMs = (hasUI: boolean): number => (hasUI ? settings.autoBackgroundMs : 0);

  // ── setup ──────────────────────────────────────────────────────────

  /**
   * A stable per-session key: the session id survives a /reload (so adopted
   * jobs are found again) and differs across /new and /resume (so sessions never
   * reconcile or kill each other's jobs). Falls back to a cwd hash only when no
   * session manager is present (e.g. the unit harness).
   */
  function sessionKey(ctx: UiContext): string {
    let id: string | undefined;
    try {
      id = ctx.sessionManager?.getSessionId?.();
    } catch {
      // ignore — fall through to the cwd hash
    }
    if (id) return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    return createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 16);
  }

  /** Remove sibling session dirs untouched for a week (a crash leaves the dir). */
  function sweepOldDirs(keep: string): void {
    let names: string[];
    try {
      names = readdirSync(ROOT);
    } catch {
      return;
    }
    const cutoff = Date.now() - MAX_SESSION_DIR_AGE_MS;
    for (const name of names) {
      if (name === keep) continue; // never sweep the session we are starting
      const p = join(ROOT, name);
      try {
        const st = statSync(p);
        if (st.isDirectory() && st.mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
      } catch {
        // A dir we cannot stat or remove is not worth failing startup over.
      }
    }
  }

  function loadSettings(cwd: string): string[] {
    for (const file of [join(cwd, ".pi", "shell-background.json"), join(getAgentDir(), "shell-background.json")]) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = resolveSettings(JSON.parse(raw));
        settings = parsed.settings;
        return parsed.warnings;
      } catch (err) {
        settings = DEFAULT_SETTINGS;
        return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
      }
    }
    const parsed = resolveSettings(undefined);
    settings = parsed.settings;
    return parsed.warnings;
  }

  /** Shell + args, reusing pi's resolution; command rides in argv (not stdin). */
  function shellArgv(): { shell: string; args: string[] } {
    const cfg = getShellConfig();
    // Our stdio has stdin ignored, so a stdin command transport (legacy WSL)
    // cannot receive the command — fall back to -c, which every bash accepts.
    const args = cfg.commandTransport === "stdin" ? ["-c"] : [...cfg.args];
    return { shell: cfg.shell, args };
  }

  function stopWidgetTimer(): void {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI || !registry) return;
    lastUiCtx = ctx;
    const now = Date.now();
    const lines = buildWidgetLines(registry.all(), ctx.ui.theme as never, now);
    if (lines.length === 0) {
      ctx.ui.setWidget(WIDGET, undefined);
      stopWidgetTimer();
      return;
    }
    ctx.ui.setWidget(WIDGET, (_tui: unknown) => new Text(lines.join("\n"), 0, 0), { placement: "aboveEditor" });
    // Keep the box live between events: tick the elapsed clock while jobs run and
    // clear a finished job once it falls out of its 15s window, even if nothing
    // else fires a render. Unref'd, so a lingering box never holds the host open.
    if (!widgetTimer) {
      widgetTimer = setInterval(() => renderWidget(), 1000);
      widgetTimer.unref?.();
    }
  }

  // ── run ────────────────────────────────────────────────────────────

  function snapshot(job: Job): ToolResult {
    const tail = readTail(job.logPath, settings.tailBytes);
    return {
      content: [{ type: "text", text: `${header(job)}\n${sanitizeOutput(tail.text).replace(/\n+$/, "") || "(no output yet)"}` }],
      details: { id: job.id, status: job.status },
    };
  }

  /** The structured half of any result about a job: the whole log (bounded) plus status, for scripts. */
  function structured(job: Job): BashStructured {
    return buildStructured(job, readFull(job.logPath, STRUCTURED_OUTPUT_MAX_BYTES));
  }

  function finished(job: Job): ToolResult {
    return {
      content: [{ type: "text", text: formatResult(job, settings.tailBytes) }],
      details: { id: job.id, status: job.status, exitCode: job.exitCode, signal: job.signal, background: false },
      structuredContent: structured(job),
      isError: job.status === "failed",
    };
  }

  /** Push a finished job's result into the conversation through the live pi. */
  function deliver(job: Job): void {
    renderWidget();
    if (!settings.deliverResults) return;
    pi.sendMessage(
      {
        customType: DELIVERY_TYPE,
        content: deliveryMessage(job.id, formatResult(job, settings.tailBytes)),
        display: true,
        details: { id: job.id, status: job.status, exitCode: job.exitCode },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  /** Deliver a finished background job into the conversation, once. */
  function scheduleDelivery(job: Job, exit: Promise<unknown>): void {
    exit
      .then(() => {
        // Handed off to a newer instance: only flush the final status to disk
        // for it to read. Do not mark delivered, touch lastUiCtx, or send through
        // this stale pi (which would throw and, worse, having already flipped
        // delivered would stop the new instance from ever delivering).
        if (handedOff) {
          registry?.persist(job);
          return;
        }
        if (job.delivered) return;
        job.delivered = true;
        registry?.persist(job);
        deliver(job);
      })
      .catch(() => {
        // A /reload can make captured handles throw; delivery is a convenience,
        // shell_status still collects the result.
      });
  }

  async function runBash(
    params: { command: string; timeout?: number; background?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((r: ToolResult) => void) | undefined,
    ctx: UiContext,
  ): Promise<ToolResult> {
    lastUiCtx = ctx;
    if (!registry) throw new Error("shell-background not initialized");
    const command = String(params.command ?? "").trim();
    if (!command) return { content: [{ type: "text", text: "Empty command." }], details: {}, isError: true };

    // The cap bounds how many jobs may be alive, not whether a command runs:
    // an explicit background request over it is refused (the model can still
    // run the command in the foreground); an auto-background transition over
    // it is skipped and the command simply stays in the foreground.
    const liveOthers = (self?: string) => registry!.running().filter((j) => j.id !== self).length;
    if (params.background && liveOthers() >= settings.maxBackground) {
      const n = liveOthers();
      return {
        content: [
          {
            type: "text",
            text:
              `${n} background command${n === 1 ? " is" : "s are"} already running (maxBackground = ${settings.maxBackground}). ` +
              `shell_kill one you no longer need, wait for one with shell_status {id, wait}, or run this in the foreground without background:true.`,
          },
        ],
        details: { running: n, limit: settings.maxBackground },
        isError: true,
      };
    }

    const job = registry.create(command, ctx.cwd);
    const { shell, args } = shellArgv();

    let spawned;
    try {
      spawned = spawnToFile(shell, args, command, ctx.cwd, buildEnv(ctx, join(getAgentDir(), "bin")), job.logPath);
    } catch (err) {
      job.status = "failed";
      job.endedAt = Date.now();
      registry.persist(job);
      return { content: [{ type: "text", text: `Failed to start: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
    }
    job.pid = spawned.pid;
    registry.persist(job);
    renderWidget(ctx);

    // Settle the job record the moment the process ends, whatever else happens.
    const settle = spawned.exit.then(({ code, signal: sig }) => {
      if (job.status === "running") {
        job.status = job.killedByUs ? "killed" : sig ? "killed" : code === 0 ? "done" : "failed";
      }
      job.exitCode = code;
      job.signal = sig;
      job.endedAt = Date.now();
      // Handed off on /reload: flush the final status to the sidecar for the new
      // instance to read, but do not deliver or touch the stale UI ctx here.
      if (handedOff) {
        registry?.persist(job);
        return;
      }
      registry?.persist(job);
      renderWidget();
    });

    if (params.background) {
      scheduleDelivery(job, settle);
      const r = backgroundedResult({
        id: job.id,
        command,
        elapsedMs: 0,
        auto: false,
        interactive: ctx.hasUI,
        collectWith: "shell_status",
      });
      return { content: [{ type: "text", text: r.text }], details: r.details, structuredContent: structured(job) };
    }

    // Foreground: race the process against the auto-background threshold, an
    // optional timeout, and the turn's abort signal — streaming the tail.
    const autoMs = effectiveAutoMs(ctx.hasUI);
    const timers: NodeJS.Timeout[] = [];
    const after = (ms: number, val: string) =>
      new Promise<string>((res) => {
        const t = setTimeout(() => res(val), ms);
        t.unref?.();
        timers.push(t);
      });
    const tick = setInterval(() => onUpdate?.(snapshot(job)), 1000);
    tick.unref?.();

    const abort = new Promise<string>((res) => {
      if (!signal) return;
      if (signal.aborted) res("abort");
      else signal.addEventListener("abort", () => res("abort"), { once: true });
    });

    try {
      const race: Array<Promise<string>> = [settle.then(() => "exit")];
      if (params.timeout && params.timeout > 0) race.push(after(params.timeout * 1000, "timeout"));
      if (signal) race.push(abort);

      let outcome = await Promise.race(autoMs > 0 ? [...race, after(autoMs, "auto")] : race);

      // Over the cap, the threshold passes without moving the command: it is
      // never refused, it just keeps its foreground slot until it ends.
      let keptForeground = false;
      if (outcome === "auto" && liveOthers(job.id) >= settings.maxBackground) {
        keptForeground = true;
        outcome = await Promise.race(race);
      }

      if (outcome === "exit") {
        const r = finished(job);
        if (keptForeground) {
          r.content = [
            {
              type: "text",
              text: `${r.content[0]?.text ?? ""}\n\n[kept in the foreground: ${settings.maxBackground} background commands were already running]`,
            },
          ];
        }
        return r;
      }

      if (outcome === "auto") {
        scheduleDelivery(job, settle);
        // A timeout the caller set still applies once the command is in the
        // background: schedule the kill for the time it has left so the deadline
        // the model expects is honoured rather than silently dropped. This timer
        // deliberately outlives the `finally` below, so it is not in `timers`.
        if (params.timeout && params.timeout > 0) {
          const remaining = params.timeout * 1000 - (Date.now() - job.startedAt);
          const killAt = setTimeout(() => {
            if (job.status !== "running") return;
            job.killedByUs = true;
            killTree(job.pid);
          }, Math.max(0, remaining));
          killAt.unref?.();
        }
        const r = backgroundedResult({
          id: job.id,
          command,
          elapsedMs: Date.now() - job.startedAt,
          auto: true,
          interactive: ctx.hasUI,
          collectWith: "shell_status",
        });
        return { content: [{ type: "text", text: r.text }], details: r.details, structuredContent: structured(job) };
      }

      // timeout or abort: stop the tree, let the record settle, report partial.
      job.killedByUs = true;
      killTree(job.pid);
      // Give the tree time to actually die before reporting — up to killTree's
      // own SIGKILL grace on a timeout, briefly on an abort so the turn ends.
      const graceMs = outcome === "timeout" ? 3000 : 500;
      await Promise.race([settle, after(graceMs, "gave-up")]);
      if (outcome === "timeout" && job.status === "running") {
        // Do not print "[killed]" under a still-"running" header: the signal is
        // out but the process has not confirmed exit. Say so, and point at the
        // status tool rather than claim a death we cannot see yet.
        return {
          content: [
            {
              type: "text",
              text:
                formatResult(job, settings.tailBytes) +
                `\n\n[kill signal sent; process had not exited after 3s — shell_status ${job.id} to confirm]`,
            },
          ],
          details: { id: job.id, status: job.status },
          structuredContent: structured(job),
          isError: true,
        };
      }
      const note =
        outcome === "timeout"
          ? `\n\n[killed: exceeded the ${params.timeout}s timeout]`
          : `\n\n[killed: the turn was aborted]`;
      return {
        content: [{ type: "text", text: formatResult(job, settings.tailBytes) + note }],
        details: { id: job.id, status: job.status },
        structuredContent: structured(job),
        isError: true,
      };
    } finally {
      timers.forEach(clearTimeout);
      clearInterval(tick);
    }
  }

  // ── tools & lifecycle ────────────────────────────────────────────────

  function registerBash(cwd: string, hasUI: boolean): void {
    const original = createBashToolDefinition(cwd) as unknown as AnyTool;
    const autoMs = effectiveAutoMs(hasUI);
    // The guideline must match what runBash will actually do for this session:
    // auto-background only happens interactively with a positive threshold.
    const backgroundLine = !hasUI
      ? `This is a headless run: commands run to completion unless you pass background:true, which returns an id immediately. Nothing is delivered after your turn, so collect a backgrounded command within the same turn with shell_status {id, wait: N} (it blocks until the command finishes or the wait elapses).`
      : autoMs === 0
        ? `Commands run to completion; pass background:true for anything long-running (a server, build, or watcher) to get an id back immediately, then collect or check it with shell_status.`
        : `A command still running after ${Math.round(autoMs / 1000)}s is moved to the background and its result is delivered when it finishes; pass background:true to background a long task (a server, build, or watcher) immediately. Collect or check with shell_status.`;
    const guidelines = [
      ...(Array.isArray((original as { promptGuidelines?: unknown }).promptGuidelines)
        ? ((original as { promptGuidelines?: string[] }).promptGuidelines as string[])
        : []),
      backgroundLine,
    ];
    pi.registerTool({
      ...original,
      // pi's description promises its own truncation ("last 2000 lines or
      // 50KB … saved to a temp file"); this tool returns the last
      // `tailBytes` of a log it keeps for the whole command, and says where.
      description:
        `Execute a shell command in the current working directory. Returns stdout and stderr, interleaved as they ` +
        `arrived; a long output is shown as its last ${Math.round(settings.tailBytes / 1024)}KB with the path of the ` +
        `full log. Optionally provide a timeout in seconds, or background:true to get an id back immediately.`,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in seconds; a command that hits it is killed with its whole process tree." }),
        ),
        background: Type.Optional(
          Type.Boolean({ description: "Launch detached and return an id immediately instead of waiting for the command to finish." }),
        ),
      }),
      promptGuidelines: guidelines,
      // pi 0.99: scripts and ctx.executeTool() callers receive structuredContent
      // instead of the text. Same fields as pi's bash, plus status/job_id;
      // exit_code is absent while the command still runs in the background.
      outputSchema: bashOutputSchema,
      // Let pi render the result with its default text renderer; keep the call
      // renderer (it only needs the command) if the original had one.
      renderResult: undefined,
      execute: async (_id: string, params: never, sig: never, upd: never, ctx: never) =>
        runBash(params, sig as AbortSignal | undefined, upd as never, ctx as UiContext),
    } as never);
  }

  pi.registerTool({
    name: "shell_status",
    label: "Background shell status",
    promptSnippet: "Check or collect a backgrounded command",
    description:
      "Report a background command by id (its status and output tail), or list all this session's background commands when given no id. Pass wait (seconds, 0–300) to block until a still-running command finishes or the wait elapses — useful in a headless run where nothing is delivered after the turn. Finished results survive until the session ends.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id, e.g. bg-1. Omit to list all." })),
      wait: Type.Optional(
        Type.Number({ description: "Seconds to block while the command is still running (clamped 0–300). Default 0 — return immediately." }),
      ),
    }),
    async execute(_id: string, params: { id?: string; wait?: number }, sig?: AbortSignal): Promise<ToolResult> {
      if (!registry) return { content: [{ type: "text", text: "shell-background not initialized" }], details: {}, isError: true };
      const id = params.id?.trim();
      if (!id) return { content: [{ type: "text", text: formatList(registry.all()) }], details: {} };
      const job = registry.get(id);
      if (!job) {
        const known = registry.all().map((j) => j.id).join(", ") || "(none)";
        return { content: [{ type: "text", text: `No job "${id}". Known: ${known}` }], details: {}, isError: true };
      }
      // Optionally block until it finishes. A bounded poll of job.status (not an
      // in-memory promise) so it works for adopted jobs too — those have no
      // settle closure; their status is flipped by the adoption poller / a
      // sibling instance persisting the sidecar. Cheap: status mutates in place.
      const waitSec = Number.isFinite(params.wait) ? Math.min(300, Math.max(0, Math.floor(params.wait as number))) : 0;
      if (waitSec > 0 && job.status === "running") {
        const deadline = Date.now() + waitSec * 1000;
        while (job.status === "running" && Date.now() < deadline && !sig?.aborted) await sleep(250);
      }
      // Reading a finished job marks it collected so it will not also be
      // delivered unasked. A still-running poll must never do this: setting
      // delivered here would permanently cancel the promised auto-delivery.
      if (isFinished(job)) {
        job.delivered = true;
        registry.persist(job);
      }
      return {
        content: [{ type: "text", text: formatResult(job, settings.tailBytes) }],
        details: { id: job.id, status: job.status, exitCode: job.exitCode },
        structuredContent: structured(job),
      };
    },
  });

  pi.registerTool({
    name: "shell_kill",
    label: "Kill background shell",
    promptSnippet: "Stop a backgrounded command",
    description: "Terminate a background command and its whole process tree by id.",
    parameters: Type.Object({ id: Type.String({ description: "Job id, e.g. bg-1" }) }),
    async execute(_id: string, params: { id: string }): Promise<ToolResult> {
      if (!registry) return { content: [{ type: "text", text: "shell-background not initialized" }], details: {}, isError: true };
      const job = registry.get(params.id?.trim());
      if (!job) return { content: [{ type: "text", text: `No job "${params.id}".` }], details: {}, isError: true };
      if (job.status !== "running") {
        return { content: [{ type: "text", text: `${job.id} already ${job.status}.` }], details: { id: job.id, status: job.status } };
      }
      job.killedByUs = true;
      killTree(job.pid);
      return { content: [{ type: "text", text: `Killing ${job.id} (pid ${job.pid ?? "?"}) and its process tree.` }], details: { id: job.id } };
    },
  });

  pi.registerCommand("shell-bg", {
    description: "Background shell jobs: /shell-bg [kill <id>]",
    handler: async (args, ctx: UiContext) => {
      if (!ctx.hasUI || !registry) return;
      const [verb, id] = (args ?? "").trim().split(/\s+/);
      if (verb === "kill" && id) {
        const job = registry.get(id);
        if (job && job.status === "running") {
          job.killedByUs = true;
          killTree(job.pid);
          ctx.ui.notify(`Killing ${job.id}.`, "info");
        } else {
          ctx.ui.notify(job ? `${id} already ${job.status}.` : `No job "${id}".`, "warning");
        }
        return;
      }
      ctx.ui.notify(formatList(registry.all()), "info");
    },
  });

  /**
   * After load(), take over every job still running from a previous instance of
   * this same host — a /reload survivor (a foreign/dead host's jobs were settled
   * to orphaned by load() and are not here). Their settle/delivery closures went
   * with the old instance, so poll the sidecar the old closure keeps flushing:
   * when it flips to a finished status (or the pid is simply gone) copy that in,
   * persist, re-render, and deliver through the live pi if it was not delivered.
   * One unref'd interval for them all; it stops once none are still running.
   */
  function adoptRunning(ctx: UiContext): void {
    if (!registry) return;
    const adopted = registry.running();
    if (adopted.length === 0) return;
    lastUiCtx = ctx;
    const timer = setInterval(() => {
      if (!registry) {
        clearInterval(timer);
        return;
      }
      let anyRunning = false;
      for (const job of adopted) {
        if (job.status === "running") {
          const disk = registry.readSidecar(job.id);
          if (disk && disk.status !== "running") {
            job.status = disk.status;
            job.exitCode = disk.exitCode;
            job.signal = disk.signal;
            job.endedAt = disk.endedAt ?? Date.now();
          } else if (!isAlive(job.pid)) {
            // The old instance never flushed a final status (it crashed) but the
            // process is gone: settle it here so it is not shown running forever.
            job.status = job.killedByUs ? "killed" : "done";
            job.endedAt = job.endedAt ?? Date.now();
          }
        }
        if (job.status === "running") anyRunning = true;
        else if (!job.delivered) {
          job.delivered = true;
          registry.persist(job);
          deliver(job);
        }
      }
      renderWidget(ctx);
      if (!anyRunning) clearInterval(timer);
    }, 1000);
    timer.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    const warnings = loadSettings(ctx.cwd);
    const key = sessionKey(ctx);
    sweepOldDirs(key);
    registry = new JobRegistry(join(ROOT, key));
    registry.load();
    registerBash(ctx.cwd, ctx.hasUI);
    renderWidget(ctx);
    adoptRunning(ctx);
    if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`shell-background settings: ${warnings.join("; ")}`, "warning");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") {
      // Same host process, a fresh instance is coming right after: hand the jobs
      // off rather than kill them. This (old) instance's closures go quiet
      // (handedOff) and the new instance adopts the still-running ones from the
      // sidecars — that is what registry.ts and the README promise across /reload.
      handedOff = true;
      stopWidgetTimer();
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    // quit / new / resume / fork: this session is ending for good. Kill each
    // running tree and record it killed synchronously so a resumed/next reader
    // never sees a dead job as running, then best-effort drop this session's dir.
    if (registry) {
      for (const job of registry.running()) {
        job.killedByUs = true;
        killTree(job.pid);
        job.status = "killed";
        job.endedAt = job.endedAt ?? Date.now();
        registry.persist(job);
      }
      try {
        rmSync(registry.dir(), { recursive: true, force: true });
      } catch {
        // Windows can hold the log write stream open (EBUSY); the 7-day age
        // sweep on a later session_start collects whatever is left behind.
      }
    }
    stopWidgetTimer();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
  });
}
