/**
 * Spawn a shell command whose output streams to a log file, cross-platform.
 *
 * The obvious trick — hand the child the file's own descriptor as stdout/stderr
 * so the kernel writes it with zero JS in the path — is POSIX-only. On Windows
 * a numeric fd in `stdio` does not inherit the way it does on Unix (measured:
 * the command exits 1 and the file stays empty), which is why the background-
 * bash extensions that use it have no Windows story. This suite supports
 * Windows, so we take the portable path: pipe stdout and stderr and write them
 * into one log file ourselves.
 *
 * Losslessness then depends on draining the pipes, which we do on every chunk,
 * and on not finalizing before the tail arrives: after the process exits we
 * wait for both pipes to end, with a short grace timer so a quiet inherited
 * handle (a Windows daemonized grandchild that never closes it) still releases.
 *
 * `detached` (POSIX) makes the child a process-group leader so its whole tree
 * can be signalled (see kill.ts); `unref` keeps a running job from holding the
 * host's event loop open. The job lives as long as the session does — it is
 * killed on shutdown, not orphaned — so pipes owned by the parent are the right
 * model. Zero dependencies: node:child_process + node:fs.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface Spawned {
  pid: number | null;
  /** Resolves once, when the process exits (after its output has drained) or fails to start. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const DRAIN_GRACE_MS = 150;
/** Upper bound on waiting for the log to reach the disk, should the stream never report back. */
const FLUSH_TIMEOUT_MS = 2000;

export function spawnToFile(
  shell: string,
  shellArgs: readonly string[],
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
): Spawned {
  // Append so a re-attach or racing read never clips output already written.
  // Command output can carry private data, so the log is readable by the user
  // only (pi 1.0.3 does the same for its own output files; a no-op on Windows).
  const out = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  // A write stream with no 'error' listener turns any disk error (ENOSPC,
  // EACCES) or a stray write-after-end into an uncaught exception that takes the
  // whole pi host down. Losing a log line is survivable; crashing the host is
  // not — so swallow it here.
  out.on("error", () => {});

  let child;
  try {
    child = spawn(shell, [...shellArgs, command], {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    out.end();
    return { pid: null, exit: Promise.resolve({ code: null, signal: null }) };
  }

  const pump = (s: NodeJS.ReadableStream | null) => {
    s?.on("data", (chunk) => {
      try {
        out.write(chunk);
      } catch {
        // A closed sink must not crash the reader.
      }
    });
  };
  pump(child.stdout);
  pump(child.stderr);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    let info: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const finish = () => {
      if (settled || !info) return;
      settled = true;
      const exitInfo = info;
      // Resolve only once the log is on disk. out.write() is asynchronous, so a
      // burst of output just before the exit can still be queued here, and a
      // result read the moment the job settles would miss its tail (measured: 4
      // of 20 `seq 1 50000; echo END` runs lost the end). end()'s callback fires
      // on 'finish', after every queued write; an error or a stream that never
      // answers must not hang the job, hence the listener and the timeout.
      const done = () => {
        clearTimeout(timer);
        resolve(exitInfo);
      };
      const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      timer.unref?.();
      out.once("error", done);
      try {
        out.end(done);
      } catch {
        done(); // already closed
      }
    };
    const maybeFinish = () => {
      if (info && stdoutEnded && stderrEnded) finish();
    };

    child.stdout?.on("end", () => {
      stdoutEnded = true;
      maybeFinish();
    });
    child.stderr?.on("end", () => {
      stderrEnded = true;
      maybeFinish();
    });
    child.on("exit", (code, signal) => {
      info = { code, signal };
      maybeFinish();
      // The pipes usually end right after exit; if one is held open by a
      // detached grandchild, finalize anyway after a short grace.
      const grace = setTimeout(() => {
        stdoutEnded = true;
        stderrEnded = true;
        finish();
      }, DRAIN_GRACE_MS);
      grace.unref?.();
    });
    child.on("error", () => {
      info = info ?? { code: null, signal: null };
      stdoutEnded = true;
      stderrEnded = true;
      finish();
    });
  });

  child.unref();
  return { pid: child.pid ?? null, exit };
}
