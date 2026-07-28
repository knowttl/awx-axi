/**
 * TOON output helpers (design.md §8).
 *
 * awx-axi never imports an encoder helper from the SDK, because at the pinned
 * 0.1.8 there is none to import (§16). A handler **returns** a value to the
 * loop: an object is TOON-encoded, and a string is written through verbatim,
 * which is the one sanctioned seam for the raw log region in §8.4.
 */
import { encode } from "@toon-format/toon";

import { redact } from "./redact.js";

/** Row values after projection: whatever the encoder can put in a cell. */
export type Row = Record<string, string | number | boolean | null>;

export interface ListOutputOptions {
  /** TOON collection label, e.g. `jobs`. */
  readonly label: string;
  readonly rows: readonly Row[];
  /** AWX's own total from the envelope. Never inferred (§4.3 case 2). */
  readonly count: number | undefined;
  /**
   * The definitive empty state, stated with the filter that produced it
   * (AXI §5), e.g. `0 failed jobs in the last 24h`.
   */
  readonly empty: string;
  readonly help?: readonly string[];
}

/**
 * A list response: the total first, then the rows, then the next steps.
 *
 * The total is always present so an agent never paginates to find out how many
 * there are (AXI §4).
 */
export function listOutput(options: ListOutputOptions): Record<string, unknown> {
  if (options.rows.length === 0) {
    return withHelp({ [options.label]: options.empty }, options.help);
  }

  const output: Record<string, unknown> = {};
  if (options.count !== undefined) {
    output.count = countLine(options.rows.length, options.count);
  }
  output[options.label] = options.rows;

  return withHelp(output, options.help);
}

/** `count: 30 of 847 total`, or just the total when the list is complete. */
export function countLine(shown: number, total: number): string {
  return shown >= total ? `${total} total` : `${shown} of ${total} total`;
}

/** Project a row to a field schema, so an unlisted field cannot leak. */
export function project(
  row: Record<string, unknown>,
  fields: readonly string[],
): Row {
  const projected: Row = {};
  for (const field of fields) {
    const value = row[field];
    projected[field] =
      value === undefined ||
      value === null ||
      typeof value === "object"
        ? null
        : (value as string | number | boolean);
  }
  return projected;
}

export interface DetailOutputOptions {
  readonly label: string;
  readonly fields: Record<string, unknown>;
  readonly help?: readonly string[];
}

/** A detail response. Suggestions are optional: a detail view is self-contained. */
export function detailOutput(
  options: DetailOutputOptions,
): Record<string, unknown> {
  return withHelp({ [options.label]: options.fields }, options.help);
}

export interface Truncated {
  readonly text: string;
  readonly truncated: boolean;
  /** Characters in the untruncated value, so the agent knows what it is missing. */
  readonly total: number;
}

/**
 * Truncate a long text field rather than omitting it (AXI §3). The caller
 * suggests the escape hatch only when `truncated` is true.
 */
export function truncate(text: string, limit = 1000): Truncated {
  if (text.length <= limit) {
    return { text, truncated: false, total: text.length };
  }
  return {
    text: `${text.slice(0, limit)}... (truncated, ${text.length} chars total)`,
    truncated: true,
    total: text.length,
  };
}

export interface RawRegionOptions {
  /** The encoded header block, e.g. `{ job_stdout: {...} }`. */
  readonly header: Record<string, unknown>;
  /** The marker that opens the raw region, e.g. `stdout`. */
  readonly label: string;
  /** The log body. Redacted here, on the way to stdout (§6.4). */
  readonly body: string;
  readonly help?: readonly string[];
}

/**
 * An encoded header, then a raw log region, then an encoded help block (§8.4).
 *
 * The region between the marker and `help` is **raw text, not TOON**, and that
 * is a deliberate, documented exception rather than an oversight: a 200-line
 * body run through the encoder becomes one escaped line, which costs tokens and
 * destroys readability at once.
 */
export function rawRegion(options: RawRegionOptions): string {
  const body = redact(options.body);
  const parts = [
    encode(options.header),
    `${options.label}:`,
    body.endsWith("\n") ? body.slice(0, -1) : body,
  ];

  if (options.help !== undefined && options.help.length > 0) {
    parts.push(encode({ help: [...options.help] }));
  }

  return parts.join("\n");
}

function withHelp(
  output: Record<string, unknown>,
  help: readonly string[] | undefined,
): Record<string, unknown> {
  if (help === undefined || help.length === 0) {
    return output;
  }
  return { ...output, help: [...help] };
}
