/**
 * Read the tail of a growing log without loading the whole file.
 *
 * A background command writes its stdout and stderr straight into a file (see
 * spawn.ts), so the status tool must read it back cheaply — a chatty job can
 * produce megabytes, and `readFileSync` on that just to show the last screen is
 * how a poll turns into an OOM. So seek to the end and read a bounded window.
 *
 * The window can begin mid-character: a multibyte UTF-8 sequence split at the
 * cut would decode to a replacement char, so when we did not start at byte 0 we
 * drop the leading continuation bytes (0b10xxxxxx) until a real character
 * boundary. Zero dependencies — node:fs only.
 */
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export interface Tail {
  /** The decoded trailing text. */
  text: string;
  /** True if bytes before the window were dropped. */
  truncated: boolean;
  /** Total size of the file in bytes. */
  bytes: number;
}

export const DEFAULT_TAIL_BYTES = 64 * 1024;

export function readTail(path: string, maxBytes: number = DEFAULT_TAIL_BYTES): Tail {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", truncated: false, bytes: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { text: "", truncated: false, bytes: 0 };
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let slice = buf.subarray(0, read);
    if (start > 0) {
      // Drop a leading partial UTF-8 char left by cutting mid-sequence.
      let i = 0;
      while (i < slice.length && (slice[i]! & 0xc0) === 0x80) i++;
      slice = slice.subarray(i);
    }
    return { text: slice.toString("utf8"), truncated: start > 0, bytes: size };
  } catch {
    return { text: "", truncated: false, bytes: 0 };
  } finally {
    closeSync(fd);
  }
}

export interface FullOutput {
  content: string;
  /** True when `content` omits the middle of the log. */
  truncated: boolean;
  bytes: number;
}

/**
 * The whole log, for callers that can take more than the model-facing tail
 * (pi 0.99 hands a tool's `structuredContent` to codemode scripts). A log
 * over `maxBytes` keeps its first and last `maxBytes / 2` bytes around an
 * omission marker, cut at character boundaries — the same shape pi's own
 * bash gives scripts, so a script written for it reads ours unchanged.
 */
export function readFull(path: string, maxBytes: number): FullOutput {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { content: "", truncated: false, bytes: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { content: "", truncated: false, bytes: 0 };
    const readAt = (start: number, len: number): Buffer => {
      const buf = Buffer.allocUnsafe(len);
      let read = 0;
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return buf.subarray(0, read);
    };
    if (size <= maxBytes) return { content: readAt(0, size).toString("utf8"), truncated: false, bytes: size };
    const headBytes = Math.floor(maxBytes / 2);
    const tailBytes = maxBytes - headBytes;
    const head = new TextDecoder().decode(readAt(0, headBytes), { stream: true });
    let tail = readAt(size - tailBytes, tailBytes);
    let i = 0;
    while (i < tail.length && (tail[i]! & 0xc0) === 0x80) i++;
    tail = tail.subarray(i);
    const omitted = size - headBytes - tailBytes;
    return { content: `${head}\n\n[... ${omitted} bytes omitted ...]\n\n${tail.toString("utf8")}`, truncated: true, bytes: size };
  } catch {
    return { content: "", truncated: false, bytes: 0 };
  } finally {
    closeSync(fd);
  }
}

/** Non-empty line count of a chunk of text. */
export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").filter((l) => l.trim() !== "").length;
}
