/**
 * The bounded poll loop behind `job watch` and every `--wait` (design.md §7.9).
 *
 * Polling, not websockets (§2). The loop reads AWX's own `status` against AWX's
 * own active-state set rather than modelling job lifecycle independently (§3.3),
 * and `--timeout` is a hard ceiling: an agent that hangs is worse than one that
 * reports a timeout.
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse } from "./errors.js";
import { delay, read, type Plan } from "./registry.js";

/** AWX's `ACTIVE_STATES` at 24.6.1 (`awx/main/constants.py:44-45`). */
export const ACTIVE_STATES: readonly string[] = [
  "new",
  "pending",
  "waiting",
  "running",
];

/** Note the American single-`l` `canceled`: awx-axi never emits `cancelled`. */
export const TERMINAL_STATES: readonly string[] = [
  "successful",
  "failed",
  "error",
  "canceled",
];

export function isActiveStatus(status: unknown): boolean {
  return typeof status === "string" && ACTIVE_STATES.includes(status);
}

/**
 * True for a status AWX considers finished.
 *
 * Termination is decided against this set rather than by "not active", so a
 * response carrying no status - or one this build does not know - is surfaced as
 * unusable instead of rendered as a completed run.
 */
export function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_STATES.includes(status);
}

/** `successful` exits 0; `failed`, `error`, and `canceled` exit 1 (§7.9). */
export function succeeded(status: string): boolean {
  return status === "successful";
}

export interface PollOptions {
  /** The detail route to re-read, base-relative, e.g. `jobs/1843/`. */
  readonly route: string;
  /** Hard ceiling in milliseconds. Defaults to §7.9's 600 seconds. */
  readonly timeoutMs?: number;
  /** First interval in milliseconds. Defaults to §7.9's 5 seconds. */
  readonly intervalMs?: number;
  /** Backoff ceiling in milliseconds. Defaults to §7.9's 30 seconds. */
  readonly maxIntervalMs?: number;
  /** The complete command that resumes watching, named in `WATCH_TIMEOUT`. */
  readonly resumeCommand: string;
  /** Injected so a test can drive the clock without waiting. */
  readonly now?: () => number;
}

export interface PollResult {
  readonly status: string;
  /** The final detail body, so a caller needs no extra read to render it. */
  readonly body: unknown;
  readonly waitedMs: number;
  readonly polls: number;
}

/**
 * Read until the status leaves AWX's active set, or the timeout expires.
 *
 * Backoff doubles from the first interval to the ceiling, so a two-hour job
 * costs roughly 250 requests rather than 1440.
 */
export function* pollUntilTerminal(options: PollOptions): Plan<PollResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxIntervalMs = options.maxIntervalMs ?? 30_000;
  const start = now();

  let interval = options.intervalMs ?? 5_000;
  let polls = 0;
  let status: string | undefined;

  for (;;) {
    const response = yield* read(options.route);
    polls += 1;

    if (response.status !== 200) {
      throw errorForResponse(response, { subject: "the watched job" });
    }
    status = statusOf(response.body);

    if (isTerminalStatus(status)) {
      return {
        status: status as string,
        body: response.body,
        waitedMs: now() - start,
        polls,
      };
    }
    if (!isActiveStatus(status)) {
      throw unusableStatus(status, options.resumeCommand);
    }

    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      break;
    }

    // Clamped to what is left of the budget, so `--timeout` is the hard ceiling
    // §7.9 calls it rather than the ceiling plus one backoff interval.
    yield* delay(Math.min(interval, timeoutMs - elapsed));
    interval = Math.min(interval * 2, maxIntervalMs);
  }

  throw new AxiError(
    `still ${String(status)} after ${Math.round((now() - start) / 1000)}s`,
    "WATCH_TIMEOUT",
    [`Run \`${options.resumeCommand}\` to keep watching`],
  );
}

/**
 * A response that reports neither an active nor a finished status says nothing
 * about the run, and rendering it as an outcome would invent one.
 */
function unusableStatus(
  status: string | undefined,
  resumeCommand: string,
): AxiError {
  return new AxiError(
    status === undefined
      ? "the controller reported no status for the watched job"
      : `the controller reported an unrecognized status "${status}" for the watched job`,
    "UNKNOWN",
    [`Run \`${resumeCommand}\` to read it again`],
  );
}

function statusOf(body: unknown): string | undefined {
  const status = (body as { status?: unknown } | null)?.status;
  return typeof status === "string" && status.length > 0 ? status : undefined;
}
