/**
 * The cleaning pi's own bash tool applies to what the model sees
 * (bash-executor.ts: `sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "")`),
 * with one improvement: a carriage return is resolved, not deleted. pi drops
 * the `\r` and keeps every progress frame's text, so a 2000-frame webpack bar
 * arrives as one line holding all 2000 frames; here only the last frame of
 * each line survives, which is what the terminal showed (see shrink.ts).
 *
 * This package re-registers `bash`, and a job's log is captured raw on disk on
 * purpose (the detached spawn writes straight to a file; no in-process pipes).
 * Without this step the tail handed back for a chatty build or dev server is
 * escape codes and carriage-return progress frames — tokens the native tool
 * would never have spent. The on-disk log stays byte-for-byte; only the text
 * that reaches the model is cleaned. Zero dependencies: pi does not export
 * these helpers, so the regex (ansi-regex, MIT) and the code-point filter are
 * vendored here verbatim.
 */

import { collapseCarriageReturns } from "./shrink.ts";

// Valid string terminator sequences are BEL, ESC\, and 0x9c
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
// OSC sequences only: ESC ] ... ST (non-greedy until the first ST)
const OSC = `(?:\\u001B\\][\\s\\S]*?${ST})`;
// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :) then final byte
const CSI = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI = new RegExp(`${OSC}|${CSI}`, "g");

export function stripAnsi(text: string): string {
  // Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer.
  if (!text.includes("\u001B") && !text.includes("\u009B")) return text;
  return text.replace(ANSI, "");
}

/**
 * Drop characters that crash string-width or corrupt a terminal: control
 * characters (except tab/newline/CR), Unicode format characters, lone
 * surrogates and undefined code points.
 */
export function sanitizeBinaryOutput(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

/** What pi's bash gives the model — no ANSI, no control noise — with `\r` redraws collapsed to their last frame. */
export function sanitizeOutput(text: string): string {
  return sanitizeBinaryOutput(collapseCarriageReturns(stripAnsi(text)));
}
