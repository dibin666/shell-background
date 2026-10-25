/**
 * The messages a backgrounded command produces — when it is sent to the
 * background, and when it comes back.
 *
 * Two audiences, one hard constraint. Delivery — pushing the finished result
 * into the conversation unasked — only works if the session outlives the run.
 * An interactive session does; a headless `pi -p` run tears down the moment the
 * prompt resolves, so there is nothing left to deliver into. So the not-ready
 * message tells the truth for the mode it is in: interactive can wait, headless
 * must collect within the turn.
 *
 * Pure strings; the extension owns the clock, the processes and the host.
 */

export interface BackgroundedInput {
  id: string;
  command: string;
  elapsedMs: number;
  /** True on the auto-30s path, false when the caller asked for background. */
  auto: boolean;
  /** Whether a UI/interactive session is present to deliver into. */
  interactive: boolean;
  /** The tool to collect with, e.g. "shell_status". */
  collectWith: string;
}

function elapsed(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function clip(command: string, max = 60): string {
  const one = command.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export interface BackgroundedResult {
  text: string;
  details: {
    id: string;
    status: "running";
    background: true;
    auto: boolean;
    retryable: true;
    pollRequired: boolean;
    elapsedMs: number;
  };
}

export function backgroundedResult(input: BackgroundedInput): BackgroundedResult {
  const head = input.auto
    ? `${input.id} is still running after ${elapsed(input.elapsedMs)} — moved to the background.`
    : `${input.id} started in the background.`;
  const line = `  $ ${clip(input.command)}`;
  const tail = input.interactive
    ? [
        "Its result is delivered here automatically when it finishes, so carry on with other",
        `work. ${input.collectWith} with id "${input.id}" is only if you want it early, and ${input.collectWith}`,
        "with no id lists everything still running.",
      ]
    : [
        "This is a headless run: nothing is delivered after your turn ends. Collect it",
        `in this same turn — ${input.collectWith} {id: "${input.id}", wait: 60} blocks until it`,
        "finishes (or the wait elapses); do not end your turn expecting the result to arrive on its own.",
      ];
  return {
    text: [head, line, "", ...tail].join("\n"),
    details: {
      id: input.id,
      status: "running",
      background: true,
      auto: input.auto,
      retryable: true,
      pollRequired: !input.interactive,
      elapsedMs: input.elapsedMs,
    },
  };
}

/**
 * How a finished background job introduces itself when it arrives unasked.
 * A job the user stopped by hand says so: without that, a bare "killed" reads
 * like a crash, and the model may restart what the user just shut down.
 */
export function deliveryMessage(id: string, body: string, opts: { stoppedByUser?: boolean } = {}): string {
  const note = opts.stoppedByUser
    ? [
        `This is ${id}, a command you sent to the background. The user stopped it themselves (from /shell-bg); this is its final output.`,
        "It did not crash. Do not restart it unless the user asks; just take into account that it is no longer running.",
      ]
    : [
        `This is ${id}, a command you sent to the background; it has just finished and this is its result.`,
        "Fold it into what you are doing. If you had already moved on, say what it changes — or that it changes nothing.",
      ];
  return [`<shell_background_result id="${id}">`, body.trim(), `</shell_background_result>`, "", ...note].join("\n");
}

/** The custom-message type a delivered result travels under. */
export const DELIVERY_TYPE = "pify-shell-background-result";
