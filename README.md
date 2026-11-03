# @pify/shell-background

[![CI](https://github.com/pifydev/shell-background/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/shell-background/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/shell-background)](https://www.npmjs.com/package/@pify/shell-background) [![npm downloads](https://img.shields.io/npm/dm/@pify/shell-background)](https://www.npmjs.com/package/@pify/shell-background)

Long-running bash goes async in [pi](https://github.com/earendil-works/pi). Pass `background: true` to launch a command detached and get its id back immediately — and any foreground command still running after 30 seconds is **automatically moved to the background**, so a build, a test run, or a dev server never eats the agent's turn while it waits.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install shell-background`](https://github.com/pifydev/cli) or `pi install npm:@pify/shell-background`.

## Why

pi's bash tool waits for the command to finish. That is right for `ls` and wrong for `npm run build`: the agent sits blocked for a minute with nothing to do, and a `npm run dev` that never exits blocks it forever. The fix is to let a long command keep running in the background while the agent gets on with something else, and to hand back the result when it lands.

## What it does

It re-registers the `bash` tool with the same shell, working directory, PATH (including pi's managed `fd`/`rg` bin dir) and `PI_*` session variables pi's own bash hands a command — but a different lifecycle:

| Situation | What happens |
|---|---|
| Command finishes quickly | Returns normally, exactly like before. |
| Command still running after 30s | Moved to the background: the tool returns `moved to background, id=bg-1`, and the result is delivered into the conversation when the command finishes. |
| `background: true` | Launched detached from the start; returns the id immediately. |
| `timeout: N` | Killed (whole process tree) if it runs past N seconds. |

```
bash { command: "npm run build" }        # returns when done, or auto-backgrounds at 30s
bash { command: "npm run dev", background: true }   # → "bg-2 started in the background"
shell_status { id: "bg-2" }              # status + output so far
shell_status { id: "bg-2", wait: 60 }    # block up to 60s until it finishes (headless collect)
shell_status                             # list every background command this session
shell_kill { id: "bg-2" }                # stop it and its whole process tree
```

### `/shell-bg`

| Command | What it does |
|---|---|
| `/shell-bg tui` or `/shell-bg status` | Opens the job browser: a centered overlay listing every job with its status, searchable by id or command. |
| `/shell-bg status bg-2` | Opens that job's output directly. |
| `/shell-bg kill` | Picks a running job to stop. |
| `/shell-bg kill bg-2` | Stops that job and its whole process tree. |
| `/shell-bg list` | Shows the job list as a notification. |

A bare `/shell-bg` opens nothing; while you type it, the completion list shows the subcommands.

The arguments autocomplete. Subcommands come first (`tui`, `status`, `kill`, `list`), then job ids: `kill` offers only jobs that are still running, and `status` offers every job, with its status icon and command. Accepting `kill` or `status` from the list opens the job list straight away, and Tab after them lists jobs, not file paths.

In the browser, each job's row is colored by its status, and a legend under the list names the colors: running, done, failed, killed, orphaned (its session ended). Each row ends with how long the job ran. ↑↓ moves the selection, typing filters, Enter opens a job, and Esc or the ✕ in the top-right corner closes.

A job's view shows its log history, up to the last 2 MiB, which is more than the tail the model sees. ↑↓, PgUp/PgDn and Home/End scroll it, and it follows new lines while you are at the bottom. ← or Backspace goes back to the list, and `k` kills a running job.

A kill from the overlay always asks first. This covers `k`, `[✗ kill]`, and Enter or a click in `/shell-bg kill`'s picker. The bottom row turns into `[✗ Kill bg-2] [Cancel]` with the job's command. Enter, `y` or the Kill button stops the job. Esc, `n` or Cancel keeps it, and Esc here does not close the overlay. A `/shell-bg kill bg-2` typed with its id is already deliberate, so it stops the job without asking.

The overlay's size follows the terminal. Its width is a share of the terminal's width. The list is as tall as its jobs, up to about 70% of the terminal rows. A job's view is always exactly that 70%, however short or long its log, so the window does not jump while output streams in. A resize changes both.

In pi's fullscreen mode (the default) the mouse works too:

- The wheel scrolls.
- A click opens a job or presses `[‹ back]` / `[✗ kill]`, and a click on the ✕ closes the overlay.
- A click on a job row in the widget above the editor opens that job's output.
- Dragging over the log selects text. Double-click selects a word, triple-click a row.

A selection is copied the way pi copies one, through pi's clipboard path with its "Copied!" flash. It follows pi's `fullscreenCopyOnSelect` setting: on release, or with pi's copy key (`app.message.copy`, `ctrl+x` by default) when that setting is off. The overlay draws its own selection, so a selection spanning rows copies only the log text, without the window's border or the screen behind it. pi passes mouse events only in fullscreen mode, so every action except selecting text also has a key.

## Delivery, and the headless caveat

When a backgrounded command finishes in an **interactive** session, its result is pushed into the conversation as the next turn — you do not have to poll. Under headless `pi -p` there is nothing to deliver into (the session tears down when the prompt resolves), so **auto-background is disabled there** and only explicit `background: true` applies; collect it within the same turn with `shell_status { id, wait: N }`, which blocks (up to `N` seconds, 0–300) until the command finishes rather than returning immediately. This is the same delivery rule the rest of the suite lives by. A job's result is pushed only at the end of the current turn, not the instant the command exits, so a job you collect during the turn with `shell_status {id}` (with or without `wait`) is never also delivered as a follow-up — the model never spends a turn acknowledging a result it has just reported. A job nobody collects is delivered once when the turn ends, and a job that finishes while the agent is idle wakes it right away.

A kill is never news to whoever asked for it:

- **`shell_kill`** waits for the job to exit, up to 3.5s, past the 3s SIGTERM→SIGKILL escalation. It then reports the final status and output in its own result, and the job is not delivered again. A job still alive after the wait is delivered when it does exit.
- **A job you stop from `/shell-bg`** (`kill`, or `k` / `[✗ kill]` in the browser) does not wake the model. Its result says the user stopped it, so the model does not take it for a crash and restart it. The message is handed to the model with your next message, using pi's `nextTurn` delivery.

## How it works

Each command is spawned with its stdout and stderr piped into a single log file, drained on every chunk so nothing is lost no matter how much it prints, and finalized only after the pipes end (with a short grace so a daemonized grandchild that holds a handle open cannot truncate the tail). The process is spawned detached (POSIX) and `unref`'d so a running job never holds the host open, and killed as a whole process tree — `taskkill /T` on Windows, a process-group signal on POSIX — on timeout, abort, `shell_kill`, or session shutdown.

Shell resolution reuses pi's own `getShellConfig` (Git Bash on Windows, `/bin/bash` then `sh` on Unix) and the environment is rebuilt the way pi's bash builds it (managed bin dir on PATH, `PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL` from the session), so a backgrounded command behaves identically to a foreground one.

Jobs are tracked in memory and mirrored to a sidecar under the temp dir, keyed by the pi **session id** — so two sessions in the same directory never see or kill each other's jobs, and the id is stable across a `/reload`. A `/reload` does **not** kill background jobs: pi hands the same host process to a fresh instance, which adopts every still-running job from the sidecars and delivers each one when it finishes (exactly once). Every other way a session ends — quit, or switching to another session — kills its jobs and their whole process trees. Each record also carries the host pid that spawned it: a `running` record left by a different (or crashed) host is surfaced as `orphaned` and never treated as live, so its pid — which may since belong to something unrelated — is never signalled. A job whose process has died is reconciled rather than shown as forever-running, this session's dir is removed on a clean exit, and stray dirs from a crash are swept after seven days.

There are **no runtime dependencies**, and it works on Linux, macOS and Windows.

## Settings

Put these in `.pi/shell-background.json` (project) or `<agentDir>/shell-background.json` (global):

```json
{
  "autoBackgroundMs": 30000,
  "tailBytes": 65536,
  "tailLines": 200,
  "maxBackground": 8,
  "deliverResults": true
}
```

`autoBackgroundMs` is how long a foreground command may run before it auto-backgrounds; set it to `0` to disable auto-background (explicit `background: true` still works). `PIFY_SHELL_BG_MS` overrides it for one run or in CI. `tailBytes` bounds how much of a job's log a status result reads; `tailLines` bounds how many lines of it the model is shown (0 disables the line shrink). `maxBackground` bounds how many jobs may be alive at once: over it, a `background: true` request is refused with a message naming the limit (the command can still run in the foreground), and a command that crosses the auto-background threshold simply stays in the foreground instead of moving — a command is never refused, only the decision to background it. `deliverResults` (boolean, default `true`): when a background job finishes, its result is pushed into the conversation and wakes the agent for a new turn. Set it to `false` to turn that off — the widget still updates and `shell_status {id}` still collects the result, but nothing is injected and the agent is not woken. Bad values fall back to the defaults with a warning rather than taking the tool down.

Since pi 0.99 the bash tool also returns a machine-readable result — `structuredContent` — which codemode scripts and tools calling `ctx.executeTool("bash", …)` receive instead of the text. This package keeps pi's shape so such a script reads either tool unchanged: `output` (the whole log, up to 1 MiB, head and tail around an omission marker), `truncated`, `full_output_path`, `exit_code`, `wall_time_seconds` — plus `status` and `job_id`, because a command here can still be running when the tool returns; then `exit_code` is absent and `shell_status {id}` collects it, with the same structured result.

A backgrounded command runs with no one to answer it, so its environment says so: `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR`/`EDITOR`/`VISUAL=true` are forced (a `git commit` without `-m` fails with "empty message" instead of waiting on an editor that never comes, and an https `git fetch` fails instead of prompting for a password), and pagers default to `cat` unless you set them. `CI` and `TERM` are left alone on purpose — dev servers and watchers read them.

The tail a result carries is cleaned the way pi's own bash cleans what the model sees — ANSI escapes and control characters stripped — with two improvements borrowed from caveman's log compressors. A carriage-return redraw is **resolved to its last frame** rather than having the `\r` deleted: pi's own cleaning keeps every frame's text, so a 2000-frame progress bar arrives as one line holding all 2000 frames; here it arrives as `1999/2000`. And a long result is **shrunk by lines, not bytes**: the first and last lines are kept, every line that names trouble (`error`, `FAILED`, `Traceback`, `at …`, `File "…"`, `path:12:5:`, `FooError`, `caused by`, `exit status 1`) is kept wherever it sits, and the rest collapses into markers that count what they replaced — `[… 412 lines omitted (INFO ×380, DEBUG ×29) …]` — computed from exactly those lines. A byte window kept the *end* of a build log, where the summary is; a line window with that regex keeps the failing step in the middle too. Runs under three lines are shown as they are (a marker in place of one line only reads as a hole), the markers are recognised on a later poll so a shrunk result re-serialises identically (the provider prefix cache depends on it), and one note names what was left out and where the whole log is. The line shrink is guarded against truncating a *distinct* document: before a run of lines is collapsed, one representative of every kind of line a surviving line does not already resemble is kept (caveman's redundancy guard, vocabulary-containment with digit masking so lines differing only in a timestamp count as one). So a 50k-line repetitive build log collapses hard, while a 50k-line document where every line is distinct is kept and the shrink reports no win — the honest outcome rather than a silent deletion.

A whole JSON test report in the tail — `pytest --json-report`, `jest --json` — is rendered as counts plus every failure with its stack trimmed to the first three and last two frames (`TEST SUMMARY: 240 passed, 3 failed` then each `FAILED: …`), instead of the raw document. Detection is on the exact top-level keys, so ordinary JSON is untouched; a truncated report is not valid JSON and falls through to the line view; the full report stays on disk. (JUnit XML lands in a file rather than on stdout and is left alone.)

A log that cannot be read says `(log unavailable: …)` rather than `(no output)`, which would send the model polling for output that will never come. The log file on disk keeps every byte.

## Coexistence with @pify/pretty

Both this package and `@pify/pretty` re-register `bash`: this one to change its *execution* (async), pretty to change its *rendering* (compact, syntax-highlit). pi's `registerTool` is last-write-wins and gives an extension no way to read or wrap another's registered tool, so the two cannot be merged — whichever loads last wins the whole `bash` tool.

**Load `@pify/shell-background` after `@pify/pretty`.** Async bash is the reason to install this package, so it should own execution; pretty keeps rendering every other tool (`read`, `edit`, `grep`, `write`, `ls`, `find`) — only its `bash`-specific rendering yields, and you still get pi's default bash view here. If pretty loads last instead, *this package's async execution is lost* and bash reverts to blocking — the outcome to avoid.

(A future pi API to compose registered tools would let both apply at once; today none exists.)

## License

MIT © [Pify maintainers](https://github.com/pifydev)
