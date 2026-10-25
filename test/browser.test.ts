import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { JobBrowser, hardWrap, type BrowserSource } from "../src/browser.ts";
import type { Job, JobStatus } from "../src/types.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", enter: "\r", esc: "\x1b", backspace: "\x7f" };

function job(id: string, status: JobStatus, command: string, startedAt: number): Job {
  return {
    id,
    command,
    cwd: "/work",
    pid: 4242,
    status,
    exitCode: status === "done" ? 0 : status === "failed" ? 1 : null,
    signal: null,
    logPath: `/tmp/${id}.log`,
    startedAt,
    endedAt: status === "running" ? null : startedAt + 2000,
    auto: false,
    delivered: false,
  };
}

function setup(opts: { jobs?: Job[]; output?: (j: Job) => string; rows?: number; copyOnSelect?: boolean } = {}) {
  const jobs = opts.jobs ?? [
    job("bg-1", "done", "ls -la", Date.now() - 50_000),
    job("bg-2", "running", "npm run dev", Date.now() - 40_000),
    job("bg-3", "failed", "npm test", Date.now() - 30_000),
  ];
  const killed: string[] = [];
  const copied: string[] = [];
  let closed = 0;
  const src: BrowserSource = {
    jobs: () => jobs,
    output: opts.output ?? ((j) => `output of ${j.id}\nsecond line`),
    kill: (j) => killed.push(j.id),
    rows: () => opts.rows ?? 40,
    requestRender: () => {},
    close: () => closed++,
    copy: (t) => copied.push(t),
    copyOnSelect: () => opts.copyOnSelect ?? true,
  };
  return { jobs, killed, copied, closed: () => closed, src };
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 20, shift: false, alt: false, ctrl: false, ...extra };
}

function rowOf(lines: string[], needle: string): number {
  const i = lines.findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `no row contains ${needle}`);
  return i;
}

test("the list shows every job, newest first, each with its status and icon, within the width", () => {
  const { src } = setup();
  const b = new JobBrowser(theme, src);
  try {
    const lines = b.render(80);
    assert.ok(lines.every((l) => visibleWidth(l) === 80), "every line fits the overlay width exactly");
    assert.match(lines[0]!, /⚙ shell-bg · 1 running · 3 total/);
    const order = ["bg-3", "bg-2", "bg-1"].map((id) => rowOf(lines, id));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "newest first");
    assert.match(lines[rowOf(lines, "bg-2")]!, /⟳ bg-2 +running/);
    assert.match(lines[rowOf(lines, "bg-3")]!, /✗ bg-3 +failed \(exit 1\)/);
    assert.match(lines[rowOf(lines, "bg-1")]!, /✓ bg-1 +done \(exit 0\)/);
  } finally {
    b.dispose();
  }
});

test("arrow keys move the selection and enter opens the job's detail", () => {
  const { src } = setup();
  const b = new JobBrowser(theme, src);
  try {
    b.render(80);
    assert.equal(b.state().jobId, "bg-3", "the newest job starts selected");
    b.handleInput(KEY.down);
    assert.equal(b.state().jobId, "bg-2");
    b.handleInput(KEY.enter);
    assert.deepEqual(b.state(), { view: "detail", jobId: "bg-2", query: "" });
    const lines = b.render(80);
    assert.match(lines[0]!, /⟳ bg-2 · running/);
    assert.ok(lines.some((l) => l.includes("$ npm run dev")));
    assert.ok(lines.some((l) => l.includes("output of bg-2")));
    // ← goes back to the list with the same job still selected.
    b.handleInput(KEY.left);
    assert.deepEqual(b.state(), { view: "list", jobId: "bg-2", query: "" });
  } finally {
    b.dispose();
  }
});

test("typing filters by command or by id", () => {
  const { src } = setup();
  const b = new JobBrowser(theme, src);
  try {
    for (const ch of "npm") b.handleInput(ch);
    let lines = b.render(80);
    assert.ok(!lines.some((l) => l.includes("bg-1")), "ls -la is filtered out");
    assert.ok(lines.some((l) => l.includes("bg-2")) && lines.some((l) => l.includes("bg-3")));
    for (let i = 0; i < 3; i++) b.handleInput(KEY.backspace);
    for (const ch of "bg-1") b.handleInput(ch);
    lines = b.render(80);
    assert.deepEqual(["bg-1", "bg-2", "bg-3"].map((id) => lines.some((l) => l.includes(`${id} `))), [true, false, false]);
    b.handleInput(KEY.enter);
    assert.equal(b.state().jobId, "bg-1");
    for (const ch of "zzz") b.handleInput(ch);
  } finally {
    b.dispose();
  }
});

test("escape closes from both views", () => {
  const s = setup();
  const b = new JobBrowser(theme, s.src, { jobId: "bg-1" });
  try {
    assert.equal(b.state().view, "detail", "jobId opens straight into the detail");
    b.handleInput(KEY.esc);
    assert.equal(s.closed(), 1);
  } finally {
    b.dispose();
  }
  const s2 = setup();
  const b2 = new JobBrowser(theme, s2.src);
  b2.handleInput(KEY.esc);
  b2.dispose();
  assert.equal(s2.closed(), 1);
});

test("clicking a row opens it; wheel moves the selection", () => {
  const { src } = setup();
  const b = new JobBrowser(theme, src);
  try {
    let lines = b.render(80);
    b.handleMouse(mouse("wheel", 5, 4, { wheelDelta: 3 }));
    assert.equal(b.state().jobId, "bg-2");
    lines = b.render(80);
    const y = rowOf(lines, "bg-1");
    assert.deepEqual(b.handleMouse(mouse("press", 10, y)), { handled: true });
    assert.equal(b.state().jobId, "bg-1", "press selects");
    b.handleMouse(mouse("click", 10, y));
    assert.deepEqual(b.state(), { view: "detail", jobId: "bg-1", query: "" });

    // The [‹ back] button in the detail returns to the list.
    lines = b.render(80);
    const by = rowOf(lines, "[‹ back]");
    const bx = lines[by]!.indexOf("[‹ back]");
    b.handleMouse(mouse("press", bx + 1, by));
    b.handleMouse(mouse("click", bx + 1, by));
    assert.equal(b.state().view, "list");
  } finally {
    b.dispose();
  }
});

test("a long log scrolls, follows the tail, and the detail height is fixed by the terminal", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const { src } = setup({ output: () => long, rows: 30 });
  const b = new JobBrowser(theme, src, { jobId: "bg-2" });
  try {
    let lines = b.render(80);
    assert.ok(lines.length <= Math.floor(30 * 0.7), `height ${lines.length} fits the terminal`);
    assert.ok(lines.some((l) => l.includes("line 200")), "opens on the newest output");
    assert.ok(!lines.some((l) => l.includes("line 1 ")));
    b.handleInput("g");
    lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("line 1 ")), "home/g jumps to the top");
    b.handleMouse(mouse("wheel", 5, 8, { wheelDelta: 5 }));
    lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("line 6 ")), "wheel scrolls the output");
    b.handleInput("G");
    lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("line 200")), "end/G returns to the tail");

    // The detail's size is fixed by the terminal, not by the log: a one-line log
    // gets the same window as a 200-line one, and a resize changes both.
    const short = setup({ output: () => "one line", rows: 30 });
    const b2 = new JobBrowser(theme, short.src, { jobId: "bg-1" });
    const small = b2.render(80);
    b2.dispose();
    assert.equal(small.length, lines.length, `a short log keeps the fixed height (${small.length} vs ${lines.length})`);
    assert.equal(lines.length, Math.floor(30 * 0.7), "exactly 70% of the terminal rows");
    const empty = setup({ output: () => "", rows: 30 });
    const b3 = new JobBrowser(theme, empty.src, { jobId: "bg-1" });
    assert.equal(b3.render(80).length, lines.length, "no output still fills the window");
    b3.dispose();
    const tall = setup({ output: () => "one line", rows: 50 });
    const b4 = new JobBrowser(theme, tall.src, { jobId: "bg-1" });
    assert.equal(b4.render(80).length, Math.floor(50 * 0.7), "a taller terminal makes a taller window");
    b4.dispose();
  } finally {
    b.dispose();
  }
});

test("kill mode lists only running jobs, and enter asks before it kills the chosen one", () => {
  const s = setup();
  const b = new JobBrowser(theme, s.src, { mode: "kill" });
  try {
    let lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("bg-2")));
    assert.ok(!lines.some((l) => l.includes("bg-1 ") || l.includes("bg-3 ")), "finished jobs are not offered");
    b.handleInput(KEY.enter);
    assert.deepEqual(s.killed, [], "the first enter only asks");
    assert.equal(b.pendingKill(), "bg-2");
    lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("[✗ Kill bg-2] [Cancel]") && l.includes("Stop bg-2 (npm run dev)")));
    b.handleInput(KEY.enter);
    assert.deepEqual(s.killed, ["bg-2"]);
    assert.equal(s.closed(), 1);
  } finally {
    b.dispose();
  }
});

test("k kills a running job from its detail after a yes, and does nothing for a finished one", () => {
  const s = setup();
  const b = new JobBrowser(theme, s.src, { jobId: "bg-1" });
  try {
    b.render(80);
    b.handleInput("k");
    assert.deepEqual(s.killed, []);
    b.handleInput(KEY.left);
    b.handleInput(KEY.up); // back keeps bg-1 selected (last row); ↑ → bg-2
    b.handleInput(KEY.enter);
    assert.equal(b.state().jobId, "bg-2");
    b.handleInput("k");
    assert.deepEqual(s.killed, [], "k only asks");
    b.handleInput("y");
    assert.deepEqual(s.killed, ["bg-2"]);
    assert.equal(b.state().view, "detail", "the detail stays open after the kill");
    assert.equal(s.closed(), 0);
  } finally {
    b.dispose();
  }
});

test("each status has its own color, the run time ends the row, and a legend explains the colors", () => {
  // Real SGR codes (zero width), one per theme token, so rows keep their true width.
  const codes: Record<string, number> = { warning: 33, success: 32, error: 31, accent: 36, dim: 90, muted: 37, text: 39, border: 34 };
  const colored = { fg: (c: string, t: string) => `\x1b[${codes[c] ?? 35}m${t}\x1b[39m`, bg: (_c: string, t: string) => t, bold: (t: string) => t };
  const tag = (l: string) => l.replace(/\x1b\[(\d+)m/g, (_m, n) => (n === "39" ? "</>" : `<${Object.keys(codes).find((k) => codes[k] === Number(n)) ?? n}>`));
  const jobs = [
    job("bg-1", "done", "ls", Date.now() - 65_000),
    job("bg-2", "running", "npm run dev", Date.now() - 40_000),
    job("bg-3", "failed", "npm test", Date.now() - 30_000),
    job("bg-4", "killed", "sleep 99", Date.now() - 20_000),
    job("bg-5", "orphaned", "tail -f x", Date.now() - 10_000),
  ];
  const { src } = setup({ jobs });
  const b = new JobBrowser(colored, src);
  try {
    const raw = b.render(100);
    assert.ok(raw.every((l) => visibleWidth(l) === 100), "rows keep the overlay width");
    const lines = raw.map(tag);
    const row = (id: string) => lines.find((l) => l.includes(`${id} `))!;
    assert.match(row("bg-2"), /<warning>⟳ bg-2 running/);
    assert.match(row("bg-1"), /<success>✓ bg-1 done \(exit 0\)/);
    assert.match(row("bg-3"), /<error>✗ bg-3 failed \(exit 1\)/);
    assert.match(row("bg-4"), /<accent>◼ bg-4 killed/);
    assert.match(row("bg-5"), /<dim>◼ bg-5 orphaned/);
    // The run time is the last thing in the row, in the row's color: done ran 2s, bg-2 is still going.
    assert.match(row("bg-1"), /<success>\s*2s<\/> <border>│<\/>$/);
    assert.match(row("bg-2"), /<warning>\s*40s<\/> <border>│<\/>$/);
    const legend = lines.find((l) => l.includes("running") && l.includes("orphaned") && l.includes("killed"))!;
    assert.match(legend, /<warning>⟳ running<\/>.*<success>✓ done<\/>.*<error>✗ failed<\/>.*<accent>◼ killed<\/>.*<dim>◼ orphaned<\/>/);
  } finally {
    b.dispose();
  }
});

test("hardWrap splits exactly at the width, wide characters included", () => {
  assert.deepEqual(hardWrap("abcdefgh", 3), ["abc", "def", "gh"]);
  assert.deepEqual(hardWrap("", 3), [""]);
  assert.deepEqual(hardWrap("中文字符", 5), ["中文", "字符"]);
  assert.equal(hardWrap("x".repeat(10), 4).join(""), "x".repeat(10));
});

function bodyRowOf(lines: string[], needle: string) {
  const y = rowOf(lines, needle);
  return { y, x: lines[y]!.indexOf(needle) };
}

test("dragging over the log selects text and copies it on release, across wrapped and scrolled rows", () => {
  const long = Array.from({ length: 100 }, (_, i) => `row ${String(i + 1).padStart(3, "0")} ${"x".repeat(10)}`).join("\n");
  const s = setup({ output: () => long, rows: 30 });
  const b = new JobBrowser(theme, s.src, { jobId: "bg-1" });
  try {
    let lines = b.render(80);
    const a = bodyRowOf(lines, "row 095");
    const z = bodyRowOf(lines, "row 097");
    assert.deepEqual(b.handleMouse(mouse("press", a.x, a.y)), { handled: true, capture: true });
    b.handleMouse(mouse("drag", z.x + 6, z.y));
    lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("\x1b[7m")), "the selection is highlighted");
    b.handleMouse(mouse("release", z.x + 6, z.y));
    assert.deepEqual(s.copied, [`row 095 ${"x".repeat(10)}\nrow 096 ${"x".repeat(10)}\nrow 097`]);
    assert.equal(b.selectedText(), s.copied[0]);

    // A plain click clears the selection; nothing more is copied.
    b.handleMouse(mouse("press", a.x, a.y));
    b.handleMouse(mouse("release", a.x, a.y));
    b.handleMouse(mouse("click", a.x, a.y));
    assert.equal(b.selectedText(), undefined);
    assert.equal(s.copied.length, 1);

    // Double-click copies one word.
    b.render(80);
    b.handleMouse(mouse("click", a.x + 1, a.y, { clickCount: 2 }));
    assert.equal(s.copied.at(-1), "row");
  } finally {
    b.dispose();
  }
});

test("a selection over a wrapped line copies it back as one line", () => {
  const line = "A".repeat(70) + "B".repeat(30);
  const s = setup({ output: () => line });
  const b = new JobBrowser(theme, s.src, { jobId: "bg-1" });
  try {
    const lines = b.render(60); // text width 54: the line wraps over two rows
    const start = bodyRowOf(lines, "AAAA");
    const end = bodyRowOf(lines, "BBBB");
    b.handleMouse(mouse("press", start.x, start.y));
    b.handleMouse(mouse("drag", end.x + 29, end.y + 1));
    b.handleMouse(mouse("release", end.x + 29, end.y + 1));
    assert.equal(s.copied[0], line, "no newline where the row merely wrapped");
  } finally {
    b.dispose();
  }
});

test("with pi's copy-on-select off, a selection waits for y", () => {
  const s = setup({ copyOnSelect: false });
  const b = new JobBrowser(theme, s.src, { jobId: "bg-1" });
  try {
    const lines = b.render(80);
    const p = bodyRowOf(lines, "output of bg-1");
    b.handleMouse(mouse("press", p.x, p.y));
    b.handleMouse(mouse("drag", p.x + 5, p.y));
    b.handleMouse(mouse("release", p.x + 5, p.y));
    assert.deepEqual(s.copied, []);
    b.handleInput("y");
    assert.deepEqual(s.copied, ["output"]);
  } finally {
    b.dispose();
  }
});

test("a growing log is appended to the wrapped view, and the view keeps following it", () => {
  let text = "first\nsecond";
  const s = setup({ output: () => text, rows: 30 });
  const b = new JobBrowser(theme, s.src, { jobId: "bg-2" }); // running: re-read each tick
  try {
    b.render(80);
    text += " continued\n" + Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n");
    (b as any).outputCache.stale = true;
    const lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("new 49")), "follows to the newest line");
    b.handleInput("g");
    const top = b.render(80);
    assert.ok(top.some((l) => l.includes("second continued")), "the grown last line was re-wrapped");
  } finally {
    b.dispose();
  }
});

test("a job that finishes while its detail is open shows its final output on the next refresh", () => {
  const j = job("bg-1", "running", "build", Date.now() - 5000);
  let text = "step 1\nstep 2";
  const s = setup({ jobs: [j], output: () => text });
  const b = new JobBrowser(theme, s.src, { jobId: "bg-1" });
  try {
    assert.ok(b.render(80).some((l) => l.includes("step 2")));
    // The job prints its last lines and exits between two refreshes.
    text += "\nstep 3\nDONE";
    j.status = "done";
    j.exitCode = 0;
    j.endedAt = Date.now();
    (b as any).outputCache.stale = true; // the 1s refresh tick
    let lines = b.render(80);
    assert.ok(lines.some((l) => l.includes("DONE")), "the final output is read once the job has ended");
    assert.match(lines[0]!, /✓ bg-1 · done/);
    // Read after the end, the log is final: later ticks do not read it again.
    let reads = 0;
    s.src.output = () => (reads++, text);
    (b as any).outputCache.stale = true;
    lines = b.render(80);
    assert.equal(reads, 0);
  } finally {
    b.dispose();
  }
});

test("a kill waiting for its yes: esc and n cancel without closing, and clicks only reach the buttons", () => {
  const s = setup();
  const b = new JobBrowser(theme, s.src, { jobId: "bg-2" });
  try {
    b.render(80);
    b.handleInput("k");
    b.handleInput(KEY.esc);
    assert.equal(b.pendingKill(), null, "esc cancels the kill");
    assert.equal(s.closed(), 0, "and does not close the overlay");
    b.handleInput("k");
    b.handleInput("n");
    assert.equal(b.pendingKill(), null);
    b.handleInput("x"); // any other key while nothing is pending is just a key
    assert.deepEqual(s.killed, []);

    // The [✗ kill] button asks too; [Cancel] cancels, a click elsewhere does nothing.
    let lines = b.render(80);
    let y = rowOf(lines, "[✗ kill]");
    let x = lines[y]!.indexOf("[✗ kill]");
    b.handleMouse(mouse("press", x + 1, y));
    b.handleMouse(mouse("click", x + 1, y));
    assert.equal(b.pendingKill(), "bg-2");
    lines = b.render(80);
    y = rowOf(lines, "[Cancel]");
    b.handleMouse(mouse("click", 10, 5)); // the log: ignored while asking
    assert.equal(b.pendingKill(), "bg-2");
    b.handleMouse(mouse("click", lines[y]!.indexOf("[Cancel]") + 1, y));
    assert.equal(b.pendingKill(), null);

    // ...and [✗ Kill bg-2] confirms.
    b.handleInput("k");
    lines = b.render(80);
    y = rowOf(lines, "[✗ Kill bg-2]");
    b.handleMouse(mouse("click", lines[y]!.indexOf("[✗ Kill bg-2]") + 1, y));
    assert.deepEqual(s.killed, ["bg-2"]);
  } finally {
    b.dispose();
  }
});

test("a pending kill is dropped if the job ends on its own first", () => {
  const j = job("bg-7", "running", "make", Date.now() - 1000);
  const s = setup({ jobs: [j] });
  const b = new JobBrowser(theme, s.src, { jobId: "bg-7" });
  try {
    b.handleInput("k");
    assert.equal(b.pendingKill(), "bg-7");
    j.status = "done";
    j.endedAt = Date.now();
    const lines = b.render(80);
    assert.equal(b.pendingKill(), null);
    assert.ok(!lines.some((l) => l.includes("[Cancel]")));
    b.handleInput(KEY.enter);
    assert.deepEqual(s.killed, []);
  } finally {
    b.dispose();
  }
});

test("the ✕ in the top-right corner closes the overlay, from the list and from a job", () => {
  for (const opts of [{}, { jobId: "bg-1" }]) {
    const s = setup();
    const b = new JobBrowser(theme, s.src, opts);
    try {
      const lines = b.render(80);
      assert.equal(visibleWidth(lines[0]!), 80, "the top border keeps its width");
      assert.match(lines[0]!, / ✕ ─╮$/);
      const x = lines[0]!.indexOf("✕");
      b.handleMouse(mouse("press", x, 0));
      b.handleMouse(mouse("click", x, 0));
      assert.equal(s.closed(), 1, `closed from ${JSON.stringify(opts)}`);
      // A click a cell to its left counts too; the title does not.
      b.handleMouse(mouse("click", x - 1, 0));
      assert.equal(s.closed(), 2);
      b.handleMouse(mouse("click", 5, 0));
      assert.equal(s.closed(), 2);
    } finally {
      b.dispose();
    }
  }
});
