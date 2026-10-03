/**
 * Settings for @pify/shell-background.
 *
 * The one number that is genuinely a matter of taste is the auto-background
 * threshold: how long a foreground command may run before it is moved to the
 * background so the agent gets its turn back. Read from `.pi/shell-background.json`
 * (project) or `<agentDir>/shell-background.json` (global), with a PIFY_SHELL_BG_MS
 * env override for one-off runs and CI. Bad values fall back to the default with
 * a warning rather than taking the extension down.
 */

export interface ShellBgSettings {
  /** Foreground ms before a command auto-backgrounds. 0 disables auto-background. */
  autoBackgroundMs: number;
  /** Bytes of the log tail shown in a status/collect result. */
  tailBytes: number;
  /**
   * How many jobs may be alive at once before a request to background one
   * more is refused and an auto-background transition is skipped. Every live
   * job is a whole process tree plus an open log; a session that keeps
   * starting servers and watchers should hear about it rather than
   * accumulate them without bound. Only the backgrounding decision is capped
   * — a command itself is never refused.
   */
  maxBackground: number;
  /**
   * Whether a finished background job pushes its result into the conversation
   * (and triggers a new agent turn that explains it). false: the job still
   * finishes, the widget updates, and shell_status collects the result, but
   * nothing is injected and the agent is not woken.
   */
  deliverResults: boolean;
}

export const DEFAULT_SETTINGS: ShellBgSettings = {
  autoBackgroundMs: 30_000,
  tailBytes: 64 * 1024,
  maxBackground: 8,
  deliverResults: true,
};

type NumericKey = Exclude<keyof ShellBgSettings, "deliverResults">;

const LIMITS: Record<NumericKey, { min: number; max: number }> = {
  // 0 is allowed (disable); otherwise at least 1s so a typo of "30" (=30ms)
  // does not make every command look long-running.
  autoBackgroundMs: { min: 0, max: 3_600_000 },
  tailBytes: { min: 1024, max: 4 * 1024 * 1024 },
  maxBackground: { min: 1, max: 64 },
};

export function resolveSettings(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { settings: ShellBgSettings; warnings: string[] } {
  const settings: ShellBgSettings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push("settings file is not an object — ignored");
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!(key in DEFAULT_SETTINGS)) {
          warnings.push(`unknown setting "${key}"`);
          continue;
        }
        if (key === "deliverResults") {
          if (typeof value === "boolean") settings.deliverResults = value;
          else warnings.push(`"deliverResults" must be true or false — using ${DEFAULT_SETTINGS.deliverResults}`);
          continue;
        }
        const name = key as NumericKey;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          warnings.push(`"${key}" must be a number — using ${DEFAULT_SETTINGS[name]}`);
          continue;
        }
        settings[name] = clamp(name, value, warnings);
      }
    }
  }

  const envMs = env.PIFY_SHELL_BG_MS;
  if (envMs !== undefined && envMs !== "") {
    const n = Number(envMs);
    if (Number.isFinite(n)) settings.autoBackgroundMs = clamp("autoBackgroundMs", n, warnings);
    else warnings.push(`PIFY_SHELL_BG_MS="${envMs}" is not a number — ignored`);
  }

  return { settings, warnings };
}

function clamp(name: NumericKey, value: number, warnings: string[]): number {
  const { min, max } = LIMITS[name];
  const c = Math.round(Math.min(max, Math.max(min, value)));
  if (c !== value) warnings.push(`"${name}" clamped to ${c} (allowed ${min}–${max})`);
  return c;
}
