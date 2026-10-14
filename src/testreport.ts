/**
 * A machine-readable test report, rendered as counts plus every failure.
 * Ported from caveman's test-report compressor (JuliusBrussee/caveman,
 * engine/compressors/testreport.go), narrowed to the two JSON shapes a bash
 * command actually prints to stdout: pytest-json-report and Jest `--json`.
 * (JUnit XML lands in a file, not on stdout, and parsing it well needs an XML
 * dependency this package does not take.)
 *
 * No failure is ever dropped: the summary counts every outcome, and each
 * failure keeps its name, message and a stack trimmed to its first three and
 * last two frames. Detection gates on the exact top-level keys, so ordinary
 * JSON that merely mentions them is left to the normal tail. Pure; the full
 * log stays on disk for recovery.
 */

export interface TestReport {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  duration?: number;
  other: Record<string, number>;
  failures: Array<{ name: string; message: string; type: "failure" | "error"; stack: string[] }>;
}

/** Keep a stack's first 3 and last 2 real frames, only when that drops at least 3. */
export function trimStack(frames: string[]): string[] {
  const clean = frames
    .map((f) => f.trim())
    .filter((f) => f !== "" && (/^at /.test(f) || /\.(py|java|js|ts|rb|go):/.test(f)));
  if (clean.length < 8) return clean;
  return [...clean.slice(0, 3), `... (${clean.length - 5} frames omitted)`, ...clean.slice(-2)];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parsePytest(doc: Record<string, unknown>): TestReport | null {
  if (!Array.isArray(doc.tests)) return null;
  const r: TestReport = { passed: 0, failed: 0, skipped: 0, errors: 0, duration: num(doc.duration) || undefined, other: {}, failures: [] };
  for (const t of doc.tests) {
    if (!t || typeof t !== "object") continue;
    const test = t as Record<string, unknown>;
    const outcome = typeof test.outcome === "string" ? test.outcome : "";
    const stageRepr = (name: string): string => {
      const stage = test[name];
      const lr = stage && typeof stage === "object" ? (stage as Record<string, unknown>).longrepr : undefined;
      return typeof lr === "string" ? lr : "";
    };
    const longrepr = stageRepr("call") || stageRepr("setup") || stageRepr("teardown");
    const nodeid = typeof test.nodeid === "string" ? test.nodeid : "(unknown)";
    if (outcome === "passed") r.passed++;
    else if (outcome === "skipped") r.skipped++;
    else if (outcome === "failed" || outcome === "error") {
      const isError = outcome === "error";
      isError ? r.errors++ : r.failed++;
      let message = "";
      const stack: string[] = [];
      for (const raw of longrepr.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        if (!isError && line.startsWith("E ")) {
          if (!message) message = line.slice(2).trim();
        } else if (line.includes(".py:") || line.startsWith("at ")) stack.push(line);
        else if (isError && !message && !line.includes(".py:")) message = line;
      }
      r.failures.push({ name: nodeid, message, type: isError ? "error" : "failure", stack: trimStack(stack) });
    } else if (outcome) r.other[outcome] = (r.other[outcome] ?? 0) + 1;
  }
  return r;
}

function parseJest(doc: Record<string, unknown>): TestReport | null {
  if (!Array.isArray(doc.testResults)) return null;
  const r: TestReport = {
    passed: num(doc.numPassedTests),
    failed: num(doc.numFailedTests),
    skipped: num(doc.numPendingTests),
    errors: 0,
    other: {},
    failures: [],
  };
  for (const suite of doc.testResults) {
    const results = suite && typeof suite === "object" ? (suite as Record<string, unknown>).assertionResults : undefined;
    if (!Array.isArray(results)) continue;
    for (const a of results) {
      if (!a || typeof a !== "object") continue;
      const test = a as Record<string, unknown>;
      if (test.status !== "failed") continue;
      const ancestors = Array.isArray(test.ancestorTitles) ? (test.ancestorTitles as unknown[]).map(String) : [];
      const title = typeof test.title === "string" ? test.title : "";
      const name = (typeof test.fullName === "string" && test.fullName) || [...ancestors, title].filter(Boolean).join(" › ") || "(unnamed)";
      let message = "";
      const stack: string[] = [];
      const msgs = Array.isArray(test.failureMessages) ? test.failureMessages : [];
      if (msgs.length > 0 && typeof msgs[0] === "string") {
        for (const raw of (msgs[0] as string).split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          if (line.startsWith("at ") || line.includes(".test.") || line.includes(".spec.")) stack.push(line);
          else if (!message) message = line;
        }
      }
      r.failures.push({ name, message, type: "failure", stack: trimStack(stack) });
    }
  }
  return r;
}

/** Parse a JSON test report, or null when the text is not one. Detection is on exact top-level keys. */
export function parseTestReport(text: string): TestReport | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  // Byte pre-check so ordinary JSON is not parsed twice.
  if (!trimmed.includes('"exitcode"') && !trimmed.includes('"numFailedTests"')) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const top = doc as Record<string, unknown>;
  const report = "exitcode" in top && Array.isArray(top.tests) ? parsePytest(top)
    : "numFailedTests" in top && Array.isArray(top.testResults) ? parseJest(top)
    : null;
  if (!report) return null;
  const total = report.passed + report.failed + report.skipped + report.errors + Object.values(report.other).reduce((a, b) => a + b, 0);
  return total === 0 ? null : report;
}

export function renderTestReport(r: TestReport): string {
  const parts: string[] = [];
  if (r.passed > 0) parts.push(`${r.passed} passed`);
  if (r.failed > 0) parts.push(`${r.failed} failed`);
  if (r.errors > 0) parts.push(`${r.errors} errors`);
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
  for (const name of Object.keys(r.other).sort()) parts.push(`${r.other[name]} ${name}`);
  let out = `TEST SUMMARY: ${parts.join(", ")}`;
  if (r.duration && r.duration > 0) out += ` (${r.duration.toFixed(1)}s)`;
  for (const f of r.failures) {
    out += `\n\n${f.type === "error" ? "ERROR" : "FAILED"}: ${f.name}`;
    if (f.message) for (const line of f.message.trim().split("\n")) out += `\n  ${line}`;
    for (const frame of f.stack) out += `\n  ${frame}`;
  }
  return out;
}

/** `N failed, M passed`-style summary, or null — for a one-line collapsed row. */
export function testCountLine(r: TestReport): string {
  const parts: string[] = [];
  if (r.failed > 0) parts.push(`${r.failed} failed`);
  if (r.errors > 0) parts.push(`${r.errors} errors`);
  if (r.passed > 0) parts.push(`${r.passed} passed`);
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
  return parts.join(", ");
}
