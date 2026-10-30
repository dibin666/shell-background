/**
 * The `/shell-bg` job browser: a centered overlay with two views.
 *
 *   list    every job (or, picking a job to kill, only running ones), newest
 *           first, filtered live by a search box that matches the id or the
 *           command. Each row is colored by its status and ends with how long
 *           the job ran. ↑↓ / wheel select, enter / click opens, and a scrollbar
 *           on the right edge drags the view when the list is taller than it.
 *   detail  one job: its command, status and its log history (cleaned),
 *           scrollable with ↑↓ / PgUp / PgDn / Home / End, the wheel, or the
 *           scrollbar on the right edge, and following new output while
 *           scrolled to the bottom. Dragging the mouse selects log text
 *           (double-click a word, triple-click a line) and copies it through
 *           pi's own clipboard path.
 *
 * Esc closes the overlay from either view; ← / backspace / "‹ back" returns
 * from a job to the list. Every mouse action has a keyboard path, since pi
 * only routes mouse events to components in fullscreen mode.
 *
 * Sizing follows the terminal: width is a share of it (chosen by the
 * extension). The list is as tall as its jobs, up to ~70% of the rows; a job's
 * detail is always exactly that 70%, however short or long its log, so the
 * window does not jump while output streams in. Both are re-measured on every
 * render, so a resize just works.
 */
import {
  Input,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Job } from "./types.ts";
import { matchesJob, sortJobs } from "./commands.ts";
import { SHELL_BG_ICON, STATUS_ORDER, elapsed, oneLine, statusColor, statusIcon, type WidgetTheme } from "./widget.ts";

export type BrowserTheme = WidgetTheme & { bg(color: string, text: string): string };

export interface BrowserSource {
  /** The live job list; read on every render, so status changes show up. */
  jobs(): Job[];
  /** The job's cleaned output (its log history). */
  output(job: Job): string;
  /** Stop a running job (the caller notifies). */
  kill(job: Job): void;
  /** Terminal height, for sizing. */
  rows(): number;
  requestRender(): void;
  /** Close the overlay. */
  close(): void;
  /** Put text on the clipboard (pi's path). Absent: selection still works, nothing is copied. */
  copy?(text: string): void;
  /** pi's "copy on select" setting; when false, a selection waits for pi's copy key (or y). */
  copyOnSelect?(): boolean;
  /** Is this keypress pi's copy key (app.message.copy, ctrl+x by default)? */
  isCopyKey?(data: string): boolean;
  /** That key, for the hint line. */
  copyKeyLabel?: string;
}

export interface BrowserOptions {
  /** "kill": list only running jobs, and enter/click stops the chosen one. */
  mode?: "view" | "kill";
  /** Open straight into this job's detail. */
  jobId?: string;
}

type Button = { x0: number; x1: number; action: () => void };

/** One display row of the log: a hard-wrapped slice of a logical line. */
interface BodyLine {
  text: string;
  /** True when this row continues the previous one's logical line (a wrap, not a newline). */
  cont: boolean;
}

/** A position in the wrapped log: row index and visible column. */
interface Pos {
  line: number;
  col: number;
}

const REFRESH_MS = 1000;
const AUTOSCROLL_MS = 60;
/** Left edge of content inside the frame: "│ ". */
const CONTENT_X = 2;
/** Height share of the terminal the overlay may grow to. */
const HEIGHT_SHARE = 0.7;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function statusLabel(job: Job): string {
  if (job.status === "running") return "running";
  if (job.status === "orphaned") return "orphaned";
  if (job.signal) return `${job.status} (${job.signal})`;
  if (job.status === "killed") return "killed";
  return `${job.status} (exit ${job.exitCode ?? "?"})`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Hard-wrap one logical line to `width` columns. Exact (no word breaking, no
 * dropped spaces), so a selection across a wrap copies back the original line.
 */
export function hardWrap(line: string, width: number): string[] {
  if (line === "") return [""];
  const w = Math.max(1, width);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(line)) {
    const out: string[] = [];
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
    return out;
  }
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  for (const { segment } of segmenter.segment(line)) {
    const gw = visibleWidth(segment);
    if (curW + gw > w && cur !== "") {
      out.push(cur);
      cur = "";
      curW = 0;
    }
    cur += segment;
    curW += gw;
  }
  out.push(cur);
  return out;
}

export class JobBrowser implements Focusable {
  private readonly theme: BrowserTheme;
  private readonly src: BrowserSource;
  private readonly mode: "view" | "kill";
  private readonly input: Input;
  private view: "list" | "detail" = "list";
  private isFocused = false;

  // list state
  private selectedId: string | null = null;
  private listOffset = 0;
  private listRows = 1;

  // detail state
  private detailId: string | null = null;
  private scroll = 0;
  private follow = true;
  private bodyRows = 1;
  private bodyTop = 0;
  private textW = 1;
  /** `final`: read after the job ended, so the log will not change again. */
  private outputCache: { id: string; text: string; final: boolean; stale: boolean } | null = null;
  private body: BodyLine[] = [];
  private bodyKey: { id: string; text: string; width: number; lastStart: number; lastRow: number } | null = null;

  // selection state (detail view)
  private sel: { anchor: Pos; focus: Pos } | null = null;
  private selecting = false;
  private dragged = false;
  private autoScrollDir = 0;
  private autoScrollTimer: NodeJS.Timeout | null = null;

  // scrollbar state (both views share the one column at the right edge;
  // geometry is rebuilt by every render, in overlay-local coordinates)
  private barX = -1; // first column that counts as the bar: the bar cell, the inner pad and the border after it
  private barTop = 0; // the track's first row
  private barRows = 0; // the track's height — 0 while the view fits, so its edge stays plain rows
  private barThumbY = 0; // the thumb's first row
  private barThumbH = 0;
  /** A scrollbar drag in progress: where inside the thumb the press landed. */
  private barDrag: { grabOffset: number } | null = null;

  /** A kill waiting for a second yes: the job id. Every kill from the overlay asks first. */
  private confirmId: string | null = null;

  // mouse layout, rebuilt by every render (overlay-local rows)
  private rowIds = new Map<number, string>();
  private buttons = new Map<number, Button[]>();

  private readonly timer: NodeJS.Timeout;

  constructor(theme: BrowserTheme, src: BrowserSource, options: BrowserOptions = {}) {
    this.theme = theme;
    this.src = src;
    this.mode = options.mode ?? "view";
    this.input = new Input({ prompt: "", placeholder: "type to filter by id or command" });
    if (options.jobId && this.mode === "view") {
      this.selectedId = options.jobId;
      this.openDetail(options.jobId);
    }
    // Keep elapsed clocks, statuses and a growing log live while open.
    this.timer = setInterval(() => {
      if (this.outputCache) this.outputCache.stale = true; // outputOf() re-reads a log that can still grow
      this.src.requestRender();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    // Only the list shows the search box; its cursor must follow our focus (IME placement).
    this.input.focused = value && this.view === "list";
  }

  /** Which view is showing, and for detail which job — for the extension and tests. */
  state(): { view: "list" | "detail"; jobId: string | null; query: string } {
    return { view: this.view, jobId: this.view === "detail" ? this.detailId : this.selectedId, query: this.input.getValue() };
  }

  /** The job a kill is waiting to be confirmed for, if any. */
  pendingKill(): string | null {
    return this.confirmId;
  }

  /** The currently selected log text, if any. */
  selectedText(): string | undefined {
    const range = this.selRange();
    if (!range) return undefined;
    const { s, e } = range;
    let out = "";
    for (let i = s.line; i <= e.line; i++) {
      const row = this.body[i];
      if (!row) break;
      const rowW = visibleWidth(row.text);
      const a = i === s.line ? Math.min(s.col, rowW) : 0;
      const b = i === e.line ? Math.min(e.col + 1, rowW) : rowW;
      if (i > s.line && !row.cont) out += "\n";
      if (b > a) out += sliceByColumn(row.text, a, b - a, true);
    }
    return out === "" ? undefined : out;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stopAutoScroll();
  }

  invalidate(): void {
    this.bodyKey = null;
    this.input.invalidate();
  }

  // ── data ───────────────────────────────────────────────────────────

  private filtered(): Job[] {
    const all = this.src.jobs();
    const pool = this.mode === "kill" ? all.filter((j) => j.status === "running") : all;
    const q = this.input.getValue();
    return sortJobs(pool).filter((j) => matchesJob(j, q));
  }

  private job(id: string | null): Job | undefined {
    return id ? this.src.jobs().find((j) => j.id === id) : undefined;
  }

  /** The log, re-read each tick until a read made after the job ended. */
  private outputOf(job: Job): string {
    const c = this.outputCache;
    if (c && c.id === job.id && (c.final || !c.stale)) return c.text;
    const text = this.src.output(job);
    this.outputCache = { id: job.id, text, final: job.status !== "running", stale: false };
    return text;
  }

  /** Wrap the log to rows, incrementally when it only grew (a running job). */
  private wrapBody(id: string, text: string, width: number): BodyLine[] {
    const k = this.bodyKey;
    if (k && k.id === id && k.width === width && k.text === text) return this.body;
    let from = 0;
    if (k && k.id === id && k.width === width && text.startsWith(k.text)) {
      // Appended output: re-wrap only from the start of the last logical line.
      from = k.lastStart;
      this.body.length = k.lastRow;
    } else {
      this.body = [];
      this.sel = null; // rows shifted (log rotated past the window, resize, other job)
    }
    let lastStart = from;
    let lastRow = this.body.length;
    const tail = text.slice(from);
    const logical = tail.split("\n");
    let offset = from;
    logical.forEach((raw, idx) => {
      if (idx === logical.length - 1) {
        lastStart = offset;
        lastRow = this.body.length;
      }
      const rows = hardWrap(raw.replace(/\t/g, "    "), width);
      rows.forEach((r, j) => this.body.push({ text: r, cont: j > 0 }));
      offset += raw.length + 1;
    });
    this.bodyKey = { id, text, width, lastStart, lastRow };
    return this.body;
  }

  // ── actions ────────────────────────────────────────────────────────

  private openDetail(id: string): void {
    this.view = "detail";
    this.detailId = id;
    this.scroll = 0;
    this.follow = true; // land on the newest output
    this.outputCache = null;
    this.bodyKey = null;
    this.body = [];
    this.sel = null;
    this.barDrag = null;
    this.input.focused = false;
  }

  private backToList(): void {
    this.view = "list";
    if (this.detailId) this.selectedId = this.detailId;
    this.detailId = null;
    this.sel = null;
    this.selecting = false;
    this.stopAutoScroll();
    this.barDrag = null;
    this.input.focused = this.isFocused;
  }

  private activate(job: Job | undefined): void {
    if (!job) return;
    if (this.mode === "kill") this.askKill(job);
    else this.openDetail(job.id);
  }

  /** A kill from the overlay is never one keypress or click away: ask first. */
  private askKill(job: Job | undefined): void {
    if (job && job.status === "running") this.confirmId = job.id;
  }

  private confirmKill(): void {
    const job = this.job(this.confirmId);
    this.confirmId = null;
    if (job && job.status === "running") this.src.kill(job);
    if (this.mode === "kill") this.src.close();
  }

  private moveSelection(delta: number): void {
    const list = this.filtered();
    if (list.length === 0) return;
    let i = list.findIndex((j) => j.id === this.selectedId);
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(list.length - 1, i + delta));
    this.selectedId = list[i]!.id;
  }

  private scrollBy(delta: number): void {
    this.scroll = Math.max(0, this.scroll + delta);
    this.follow = false; // render() clamps, and follows again once back at the bottom
  }

  private copySelection(): void {
    const text = this.selectedText();
    if (text) this.src.copy?.(text);
  }

  // ── selection ──────────────────────────────────────────────────────

  private selRange(): { s: Pos; e: Pos } | null {
    if (!this.sel) return null;
    const { anchor: a, focus: f } = this.sel;
    if (a.line === f.line && a.col === f.col && !this.dragged && this.selecting) return null;
    const before = a.line < f.line || (a.line === f.line && a.col <= f.col);
    return before ? { s: a, e: f } : { s: f, e: a };
  }

  /** Map overlay-local mouse coordinates to a log position (clamped to the body). */
  private posAt(x: number, y: number): Pos {
    const rowInView = Math.max(0, Math.min(this.bodyRows - 1, y - this.bodyTop));
    const line = Math.max(0, Math.min(this.body.length - 1, this.scroll + rowInView));
    const col = Math.max(0, Math.min(this.textW - 1, x - CONTENT_X));
    return { line, col };
  }

  private inBody(x: number, y: number): boolean {
    return (
      this.view === "detail" &&
      this.body.length > 0 &&
      y >= this.bodyTop &&
      y < this.bodyTop + this.bodyRows &&
      x >= CONTENT_X &&
      x < CONTENT_X + this.textW
    );
  }

  private wordAt(p: Pos): { s: Pos; e: Pos } {
    const text = this.body[p.line]?.text ?? "";
    const cells: Array<{ seg: string; start: number; end: number }> = [];
    let x = 0;
    for (const { segment } of segmenter.segment(text)) {
      const w = visibleWidth(segment);
      cells.push({ seg: segment, start: x, end: x + w });
      x += w;
    }
    const isWord = (s: string) => /[\p{L}\p{N}_\-./:@~]/u.test(s);
    let i = cells.findIndex((c) => p.col >= c.start && p.col < c.end);
    if (i < 0 || !isWord(cells[i]!.seg)) return { s: p, e: p };
    let a = i;
    let b = i;
    while (a > 0 && isWord(cells[a - 1]!.seg)) a--;
    while (b < cells.length - 1 && isWord(cells[b + 1]!.seg)) b++;
    return { s: { line: p.line, col: cells[a]!.start }, e: { line: p.line, col: cells[b]!.end - 1 } };
  }

  private startAutoScroll(dir: number): void {
    this.autoScrollDir = dir;
    if (this.autoScrollTimer) return;
    this.autoScrollTimer = setInterval(() => {
      if (!this.selecting || this.autoScrollDir === 0 || !this.sel) {
        this.stopAutoScroll();
        return;
      }
      this.scroll = Math.max(0, this.scroll + this.autoScrollDir);
      const edge = this.autoScrollDir < 0 ? this.bodyTop : this.bodyTop + this.bodyRows - 1;
      this.sel.focus = this.posAt(CONTENT_X + this.sel.focus.col, edge);
      this.src.requestRender();
    }, AUTOSCROLL_MS);
    this.autoScrollTimer.unref?.();
  }

  private stopAutoScroll(): void {
    this.autoScrollDir = 0;
    if (this.autoScrollTimer) {
      clearInterval(this.autoScrollTimer);
      this.autoScrollTimer = null;
    }
  }

  // ── scrollbar ──────────────────────────────────────────────────────

  /** Is (x, y) on the scrollbar? Only while the view is taller than its window. */
  private onScrollbar(x: number, y: number): boolean {
    return this.barRows > 0 && x >= this.barX && y >= this.barTop && y < this.barTop + this.barRows;
  }

  /**
   * A press on the bar starts a drag — pi's own gesture: grabbing the thumb
   * keeps the grabbed spot under the pointer, and pressing the track jumps
   * the thumb so its middle lands on the press (and the drag goes on from
   * there).
   */
  private pressScrollbar(y: number): void {
    const onThumb = y >= this.barThumbY && y < this.barThumbY + this.barThumbH;
    const grabOffset = onThumb ? y - this.barThumbY : Math.floor(this.barThumbH / 2);
    if (!onThumb) this.scrollThumbTo(y, grabOffset);
    this.barDrag = { grabOffset };
  }

  /** Scroll so the thumb point grabbed at `grabOffset` sits at row y. */
  private scrollThumbTo(y: number, grabOffset: number): void {
    const maxThumb = Math.max(0, this.barRows - this.barThumbH);
    const thumbOffset = Math.max(0, Math.min(maxThumb, y - this.barTop - grabOffset));
    const share = maxThumb === 0 ? 0 : thumbOffset / maxThumb;
    if (this.view === "detail") {
      const maxScroll = Math.max(0, this.body.length - this.bodyRows);
      this.scroll = Math.round(share * maxScroll);
      this.follow = false; // render() follows again once dragged back to the bottom
    } else {
      // The list has no free scroll: the view follows the selection, so moving
      // it means moving the selection with it — keeping the selected row on
      // the same screen row.
      const list = this.filtered();
      if (list.length === 0) return;
      const maxOffset = Math.max(0, list.length - this.listRows);
      const offset = Math.round(share * maxOffset);
      const sel = Math.max(0, list.findIndex((j) => j.id === this.selectedId));
      const screenRow = sel - this.listOffset;
      this.listOffset = offset;
      const next = Math.max(0, Math.min(list.length - 1, offset + screenRow));
      this.selectedId = list[next]!.id;
    }
  }

  // ── input ──────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.confirmId) {
      // While a kill waits for its yes, only yes or no count — and Esc means no, not "close".
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "y" || data === "Y") this.confirmKill();
      else if (matchesKey(data, "escape") || data === "n" || data === "N") this.confirmId = null;
      this.src.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.src.close();
      return;
    }
    if (this.view === "list") this.handleListKey(data);
    else this.handleDetailKey(data);
    this.src.requestRender();
  }

  private handleListKey(data: string): void {
    if (matchesKey(data, "up")) this.moveSelection(-1);
    else if (matchesKey(data, "down")) this.moveSelection(1);
    else if (matchesKey(data, "pageUp")) this.moveSelection(-Math.max(1, this.listRows - 1));
    else if (matchesKey(data, "pageDown")) this.moveSelection(Math.max(1, this.listRows - 1));
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const list = this.filtered();
      this.activate(list.find((j) => j.id === this.selectedId) ?? list[0]);
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) {
        // A new query starts at the top match.
        this.listOffset = 0;
        this.selectedId = this.filtered()[0]?.id ?? null;
      }
    }
  }

  private handleDetailKey(data: string): void {
    const page = Math.max(1, this.bodyRows - 1);
    if (matchesKey(data, "up")) this.scrollBy(-1);
    else if (matchesKey(data, "down")) this.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scrollBy(-page);
    else if (matchesKey(data, "pageDown") || data === " ") this.scrollBy(page);
    else if (matchesKey(data, "home") || data === "g") {
      this.scroll = 0;
      this.follow = false;
    } else if (matchesKey(data, "end") || data === "G") this.follow = true;
    else if (matchesKey(data, "left") || matchesKey(data, "backspace") || data === "q") this.backToList();
    else if (data === "k") this.askKill(this.job(this.detailId));
    else if (data === "y" || this.src.isCopyKey?.(data) || matchesKey(data, "ctrl+c")) this.copySelection();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "move") return undefined;
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return { handled: true, render: false };
      if (this.view === "list") this.moveSelection(delta < 0 ? -1 : 1);
      else this.scrollBy(delta);
      return { handled: true };
    }

    // A text selection in progress owns the pointer until release.
    if (this.selecting && this.sel) {
      if (event.type === "drag") {
        this.dragged = true;
        this.sel.focus = this.posAt(event.x, event.y);
        if (event.y < this.bodyTop) this.startAutoScroll(-1);
        else if (event.y >= this.bodyTop + this.bodyRows) this.startAutoScroll(1);
        else this.stopAutoScroll();
        return { handled: true };
      }
      if (event.type === "release") {
        this.selecting = false;
        this.stopAutoScroll();
        if (this.dragged && this.src.copyOnSelect?.() !== false) this.copySelection();
        if (!this.dragged) this.sel = null;
        return { handled: true };
      }
    }

    // A scrollbar drag owns the pointer until release, like a selection does.
    if (this.barDrag) {
      if (event.type === "drag") {
        this.scrollThumbTo(event.y, this.barDrag.grabOffset);
        return { handled: true };
      }
      if (event.type === "release" || event.type === "click") {
        this.barDrag = null;
        return { handled: true, render: false };
      }
      return { handled: true, render: false };
    }

    if (event.button !== "left") return { handled: true, render: false };

    if (this.confirmId) {
      // Only the buttons (yes, cancel, close) respond until the kill is answered.
      if (event.type === "click") this.buttons.get(event.y)?.find((b) => event.x >= b.x0 && event.x < b.x1)?.action();
      return { handled: true };
    }

    if (event.type === "press") {
      if (this.onScrollbar(event.x, event.y)) {
        this.pressScrollbar(event.y);
        return { handled: true, capture: true };
      }
      if (this.inBody(event.x, event.y)) {
        const p = this.posAt(event.x, event.y);
        this.sel = { anchor: p, focus: p };
        this.selecting = true; // render() stops following, so the text stays under the pointer
        this.dragged = false;
        this.follow = false;
        return { handled: true, capture: true };
      }
      const id = this.view === "list" ? this.rowIds.get(event.y) : undefined;
      if (id) this.selectedId = id;
      return { handled: true };
    }
    if (event.type === "click") {
      const button = this.buttons.get(event.y)?.find((b) => event.x >= b.x0 && event.x < b.x1);
      if (button) {
        button.action();
        this.src.requestRender();
        return { handled: true };
      }
      // A click on the bar (press + release in place after its press) is a
      // scroll, never a row open or a text click.
      if (this.onScrollbar(event.x, event.y)) return { handled: true, render: false };
      if (this.view === "detail") {
        // Double-click selects a word, triple-click a row — and copies, like pi.
        const count = event.clickCount ?? 1;
        if (this.inBody(event.x, event.y) && count >= 2) {
          const p = this.posAt(event.x, event.y);
          const range = count === 2 ? this.wordAt(p) : { s: { line: p.line, col: 0 }, e: { line: p.line, col: Math.max(0, visibleWidth(this.body[p.line]?.text ?? "") - 1) } };
          this.sel = { anchor: range.s, focus: range.e };
          this.dragged = true;
          if (this.src.copyOnSelect?.() !== false) this.copySelection();
        }
        return { handled: true };
      }
      // A click only fires where the press was, so the row under it is the one pressed.
      const id = this.rowIds.get(event.y);
      if (id) this.activate(this.job(id));
      return { handled: true };
    }
    return { handled: true, render: false };
  }

  // ── render ─────────────────────────────────────────────────────────

  /** The overlay's height budget: ~70% of the terminal rows (all of a tiny one). */
  private maxHeight(): number {
    const rows = Math.max(1, this.src.rows());
    return Math.max(Math.min(8, rows), Math.floor(rows * HEIGHT_SHARE));
  }

  render(width: number): string[] {
    this.rowIds.clear();
    this.buttons.clear();
    this.barX = -1;
    this.barRows = 0; // each view sets its own below
    if (this.confirmId && this.job(this.confirmId)?.status !== "running") this.confirmId = null; // it ended meanwhile
    const w = Math.max(24, width);
    if (this.view === "detail") {
      const job = this.job(this.detailId);
      if (job) return this.renderDetail(job, w);
      this.backToList(); // the job vanished (session reset) — fall back to the list
    }
    return this.renderList(w);
  }

  private frame(width: number) {
    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const inner = width - 2;
    const contentW = Math.max(1, width - 4);
    const fit = (s: string, n: number) => {
      const t = truncateToWidth(s, n);
      return t + " ".repeat(Math.max(0, n - visibleWidth(t)));
    };
    return {
      contentW,
      row: (content: string, bg?: string) => {
        const body = fit(content, contentW);
        return `${border("│")}${bg ? th.bg(bg, ` ${body} `) : ` ${body} `}${border("│")}`;
      },
      // "╭─ title ─────── ✕ ─╮": the ✕ closes the overlay. It is clickable a cell either side.
      top: (left: string) => {
        const l = truncateToWidth(` ${left} `, Math.max(1, width - 8));
        const fill = Math.max(0, width - 7 - visibleWidth(l));
        this.buttons.set(0, [{ x0: width - 5, x1: width - 2, action: () => this.src.close() }]);
        return border("╭─") + l + border("─".repeat(fill)) + ` ${th.fg("error", "✕")} ` + border("─╮");
      },
      sep: () => border(`├${"─".repeat(inner)}┤`),
      bottom: () => border(`╰${"─".repeat(inner)}╯`),
    };
  }

  /** Lay buttons out left to right in a hint row, recording their columns for clicks. */
  private buttonRow(y: number, items: Array<{ label: string; action: () => void; color?: string }>, rest: string): string {
    let x = CONTENT_X;
    const parts: string[] = [];
    const hits: Button[] = [];
    for (const it of items) {
      const label = `[${it.label}]`;
      hits.push({ x0: x, x1: x + visibleWidth(label), action: it.action });
      parts.push(this.theme.fg(it.color ?? "accent", label));
      x += visibleWidth(label) + 1;
    }
    this.buttons.set(y, hits);
    return [...parts, rest].join(" ");
  }

  /** The row that asks "kill this job?" in place of a view's hint row. */
  private confirmRow(y: number): string {
    const job = this.job(this.confirmId)!;
    const th = this.theme;
    const question = th.fg("warning", `Stop ${job.id} (${oneLine(job.command, 40)}) and its process tree?`);
    const buttons = [
      { label: `✗ Kill ${job.id}`, action: () => this.confirmKill(), color: "error" },
      { label: "Cancel", action: () => (this.confirmId = null) },
    ];
    return this.buttonRow(y, buttons, `${question} ${th.fg("dim", "enter/y kill · esc/n cancel")}`);
  }

  /** "⟳ running  ✓ done  ✗ failed  ◼ killed  ◼ orphaned", each in its own color. */
  private legend(): string {
    return STATUS_ORDER.map((s) => this.theme.fg(statusColor({ status: s }), `${statusIcon({ status: s })} ${s}`)).join("  ");
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const f = this.frame(width);
    const now = Date.now();
    const all = this.src.jobs();
    const list = this.filtered();
    const running = all.filter((j) => j.status === "running").length;

    if (!list.some((j) => j.id === this.selectedId)) this.selectedId = list[0]?.id ?? null;
    const selIndex = Math.max(0, list.findIndex((j) => j.id === this.selectedId));

    const title =
      this.mode === "kill"
        ? `${SHELL_BG_ICON} ${th.bold("shell-bg")} · kill a running job`
        : `${SHELL_BG_ICON} ${th.bold("shell-bg")} · ${running} running · ${all.length} total`;
    const lines = [f.top(th.fg("accent", title))];

    const label = th.fg("muted", "Search: ");
    const field = this.input.render(Math.max(1, f.contentW - visibleWidth(label)))[0] ?? "";
    lines.push(f.row(label + field));
    lines.push(f.sep());

    const chrome = 7; // top, search, sep, sep, legend, hint, bottom
    this.listRows = Math.max(1, Math.min(Math.max(1, list.length), this.maxHeight() - chrome));
    if (selIndex < this.listOffset) this.listOffset = selIndex;
    if (selIndex >= this.listOffset + this.listRows) this.listOffset = selIndex - this.listRows + 1;
    this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, list.length - this.listRows)));

    if (list.length === 0) {
      const empty = all.length === 0 ? "No background commands this session." : this.mode === "kill" && running === 0 ? "No running jobs." : "No job matches.";
      lines.push(f.row(th.fg("dim", empty)));
    } else {
      const idW = Math.max(...list.map((j) => j.id.length));
      const stW = Math.max(...list.map((j) => statusLabel(j).length));
      const times = new Map(list.map((j) => [j.id, elapsed(j, now)]));
      const timeW = Math.max(...[...times.values()].map((t) => t.length));
      // A one-column scrollbar when the list is taller than the view: the same
      // column the detail uses for its log, and it drags just the same.
      const scrollable = list.length > this.listRows;
      const maxOffset = Math.max(0, list.length - this.listRows);
      const thumbH = scrollable ? Math.max(1, Math.round((this.listRows * this.listRows) / list.length)) : 0;
      const thumbTop = scrollable && maxOffset > 0 ? Math.round(((this.listRows - thumbH) * this.listOffset) / maxOffset) : 0;
      this.barX = width - 3;
      this.barTop = lines.length;
      this.barRows = scrollable ? this.listRows : 0;
      this.barThumbY = this.barTop + thumbTop;
      this.barThumbH = thumbH;
      const shown = list.slice(this.listOffset, this.listOffset + this.listRows);
      for (let i = 0; i < shown.length; i++) {
        const j = shown[i]!;
        const selected = j.id === this.selectedId;
        const c = statusColor(j);
        const left = `${selected ? "›" : " "} ${statusIcon(j)} ${j.id.padEnd(idW)} ${statusLabel(j).padEnd(stW)}  `;
        const time = (times.get(j.id) ?? "").padStart(timeW);
        const cmdW = Math.max(1, f.contentW - 2 - visibleWidth(left) - timeW - 2);
        const cmd = truncateToWidth(oneLine(j.command), cmdW);
        const gap = " ".repeat(Math.max(0, cmdW - visibleWidth(cmd)) + 2);
        const content =
          th.fg(selected ? "accent" : c, left.slice(0, 2)) +
          th.fg(c, left.slice(2)) +
          (selected ? th.fg("text", cmd) : th.fg("muted", cmd)) +
          gap +
          th.fg(c, time);
        const bar = !scrollable ? " " : i >= thumbTop && i < thumbTop + thumbH ? th.fg("accent", "█") : th.fg("dim", "░");
        this.rowIds.set(lines.length, j.id);
        lines.push(f.row(`${content} ${bar}`, selected ? "selectedBg" : undefined));
      }
    }

    lines.push(f.sep());
    lines.push(f.row(this.legend()));
    const pos = list.length > this.listRows ? `  ${selIndex + 1}/${list.length}` : "";
    const hint =
      this.mode === "kill"
        ? `↑↓ select · enter/click kill · type to search · esc close${pos}`
        : `↑↓ select · enter/click open · type to search · esc close${pos}`;
    lines.push(f.row(this.confirmId ? this.confirmRow(lines.length) : th.fg("dim", hint)));
    lines.push(f.bottom());
    return lines;
  }

  private renderDetail(job: Job, width: number): string[] {
    const th = this.theme;
    const f = this.frame(width);
    const now = Date.now();
    const c = statusColor(job);
    const running = job.status === "running";

    const title = `${th.fg(c, `${statusIcon(job)} ${job.id}`)} ${th.fg("dim", "·")} ${th.fg(c, statusLabel(job))} ${th.fg("dim", `· ${elapsed(job, now)}`)}`;
    const lines = [f.top(`${SHELL_BG_ICON} ${title}`)];

    const cmdLines = wrapTextWithAnsi(oneLine(job.command), Math.max(1, f.contentW - 2)).slice(0, 3);
    cmdLines.forEach((l, i) => lines.push(f.row(`${th.fg("accent", i === 0 ? "$ " : "  ")}${l}`)));
    const meta = [
      `started ${clock(job.startedAt)}`,
      job.endedAt ? `ended ${clock(job.endedAt)}` : null,
      job.pid ? `pid ${job.pid}` : null,
      job.cwd ? `cwd ${job.cwd}` : null,
    ].filter(Boolean);
    lines.push(f.row(th.fg("dim", meta.join(" · "))));
    lines.push(f.sep());

    const text = this.outputOf(job).replace(/\n+$/, "");
    this.textW = Math.max(1, f.contentW - 2); // a space and a one-column scrollbar on the right
    const body = text.trim() === "" ? [] : this.wrapBody(job.id, text, this.textW);
    if (body.length === 0) this.body = [];
    const chrome = 1 + cmdLines.length + 1 + 1 + 1 + 1 + 1;
    // Fixed by the terminal, not the log: the window keeps its size as output arrives.
    this.bodyRows = Math.max(1, this.maxHeight() - chrome);
    const maxScroll = Math.max(0, body.length - this.bodyRows);
    if (this.follow) this.scroll = maxScroll;
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    this.follow = !this.selecting && this.scroll >= maxScroll;

    this.bodyTop = lines.length;
    if (body.length === 0) {
      lines.push(f.row(th.fg("dim", running ? "(no output yet)" : "(no output)")));
      for (let i = 1; i < this.bodyRows; i++) lines.push(f.row(""));
    } else {
      const range = this.selRange();
      // A one-column scrollbar when the output is taller than the view; it
      // takes presses and drags like pi's own scrollbars.
      const scrollable = body.length > this.bodyRows;
      const thumbH = scrollable ? Math.max(1, Math.round((this.bodyRows * this.bodyRows) / body.length)) : 0;
      const thumbTop = scrollable && maxScroll > 0 ? Math.round(((this.bodyRows - thumbH) * this.scroll) / maxScroll) : 0;
      this.barX = width - 3; // the last content column, where `bar` is drawn
      this.barTop = this.bodyTop;
      this.barRows = scrollable ? this.bodyRows : 0;
      this.barThumbY = this.barTop + thumbTop;
      this.barThumbH = thumbH;
      for (let i = 0; i < this.bodyRows; i++) {
        const idx = this.scroll + i;
        const raw = body[idx]?.text ?? "";
        const rawW = visibleWidth(raw);
        let shown = raw;
        if (range && idx >= range.s.line && idx <= range.e.line) {
          const a = idx === range.s.line ? Math.min(range.s.col, rawW) : 0;
          const b = idx === range.e.line ? Math.min(range.e.col + 1, rawW) : rawW;
          if (b > a) {
            shown =
              sliceByColumn(raw, 0, a, true) +
              `\x1b[7m${sliceByColumn(raw, a, b - a, true)}\x1b[27m` +
              sliceByColumn(raw, b, rawW - b, true);
          }
        }
        const pad = " ".repeat(Math.max(0, this.textW - rawW));
        const bar = !scrollable ? " " : i >= thumbTop && i < thumbTop + thumbH ? th.fg("accent", "█") : th.fg("dim", "░");
        lines.push(f.row(`${shown}${pad} ${bar}`));
      }
    }

    lines.push(f.sep());
    const pos =
      body.length > this.bodyRows
        ? `${this.scroll + 1}-${Math.min(body.length, this.scroll + this.bodyRows)}/${body.length}${this.follow && running ? " · following" : ""}`
        : `${body.length} line${body.length === 1 ? "" : "s"}`;
    const buttons = [{ label: "‹ back", action: () => this.backToList() }];
    if (running) buttons.push({ label: "✗ kill", action: () => this.askKill(job) });
    const copyHint = this.src.copyOnSelect?.() === false ? `drag to select, ${this.src.copyKeyLabel ?? "y"} copy` : "drag to copy";
    const keys = `↑↓ scroll · ${copyHint} · ← back${running ? " · k kill" : ""} · esc close`;
    lines.push(f.row(this.confirmId ? this.confirmRow(lines.length) : this.buttonRow(lines.length, buttons, th.fg("dim", `${keys} · ${pos}`))));
    lines.push(f.bottom());
    return lines;
  }
}
