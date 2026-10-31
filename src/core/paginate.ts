/**
 * Envelope walking (design.md §4.3 cases 1-3, §10.3).
 *
 * Collections return the server's count and continuation metadata alongside
 * budgeted rows. Internal summaries request complete reads so a safety stop
 * cannot silently produce a partial aggregate.
 */
import { AxiError } from "axi-sdk-js";

import { AwxAxiError, errorForResponse, validationError } from "./errors.js";
import type { ParsedFlags } from "./flags.js";
import type { FlagSpec } from "./registry.js";
import type { AwxResponse, PagedResult, Query } from "./transport.js";

/** A single page read, injected so both transports share one walk. */
export type PageReader = (route: string, query: Query) => Promise<AwxResponse>;

export const MAX_LIMIT = 1000;
export const MAX_ROWS = 10_000;
export const MAX_PAGES = 100;
export const PAGINATION_HELP = "\nPagination: --limit accepts 1-1000 rows; --all [--max-rows <n>] defaults to 10000 rows (maximum 10000), at most 100 pages. --all conflicts with --limit; --max-rows requires --all.";

export interface PageBudget {
  readonly maxRows: number;
  readonly all: boolean;
}

export const PAGINATION_FLAGS: readonly FlagSpec[] = [
  { name: "limit", description: `rows to return (1-${MAX_LIMIT})`, takesValue: true },
  { name: "all", description: "walk all pages within the row and page budgets", takesValue: false },
  { name: "max-rows", description: `row budget with --all (default and maximum ${MAX_ROWS})`, takesValue: true },
];

function positiveRows(raw: string | true | undefined, fallback: number, maximum: number, flag: string): number {
  const value = raw === undefined ? fallback : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw validationError(`${flag} must be a positive integer between 1 and ${maximum}`, [`Use ${flag} ${fallback}`]);
  }
  return value;
}

/** Parse collection controls once; launch-time host limits never pass here. */
export function pageBudget(flags: ParsedFlags, fallback: number): PageBudget {
  if (flags.all === true && flags.limit !== undefined) {
    throw validationError("--all and --limit cannot be combined", ["Use --all --max-rows <n> or --limit <n>"]);
  }
  if (flags.all !== true && flags["max-rows"] !== undefined) {
    throw validationError("--max-rows requires --all", ["Use --all --max-rows <n>"]);
  }
  return flags.all === true
    ? { all: true, maxRows: positiveRows(flags["max-rows"], MAX_ROWS, MAX_ROWS, "--max-rows") }
    : { all: false, maxRows: positiveRows(flags.limit, fallback, MAX_LIMIT, "--limit") };
}

/**
 * `?count_disabled` hardcodes `count` to 200 and drops `count`, `next`, and
 * `previous` from the response, which would destroy the `count: N of M total`
 * line AXI §4 requires. It is never sent, and this is the guard that keeps a
 * future contributor from adding it (§4.3 case 2).
 */
export function assertNoCountDisabled(query: Query): void {
  if ("count_disabled" in query) {
    throw new Error(
      "count_disabled is never sent: it destroys the total count (design.md §4.3 case 2)",
    );
  }
}

/**
 * Walk `next` within the collection budget; null requires a complete read.
 *
 * Page boundaries are read from the envelope and never inferred: AWX silently
 * caps an oversized `page_size` rather than rejecting it, so a client that
 * assumed it got what it asked for would under-read (§4.3 case 1).
 *
 * `page_size` is the only size parameter sent. `limit` would switch an event
 * list to `LimitPagination`, whose response carries no count at all (§4.3
 * case 3).
 */
export async function walkPages(
  read: PageReader,
  route: string,
  query: Query,
  limit: number | PageBudget | null,
): Promise<PagedResult> {
  assertNoCountDisabled(query);
  const budget = typeof limit === "number" ? { all: false, maxRows: limit } : limit;
  if (budget !== null) {
    positiveRows(String(budget.maxRows), 20, budget.all ? MAX_ROWS : MAX_LIMIT, budget.all ? "--max-rows" : "--limit");
  }
  const rowLimit = budget?.maxRows ?? Infinity;

  const rows: unknown[] = [];
  let count: number | undefined;
  let nextRoute: string | undefined = route;
  let nextQuery: Query = { ...query, page_size: budget === null ? query.page_size ?? 200 : budget.all ? Math.min(200, rowLimit) : rowLimit };
  const visited = new Set<string>();
  let pages = 0;
  let stop: PagedResult["pagination"]["stop"] = "complete";
  let continuation: string | null = null;
  let partialPage = false;

  while (nextRoute !== undefined) {
    const key = JSON.stringify([nextRoute, Object.entries(nextQuery).sort(([a], [b]) => a.localeCompare(b))]);
    if (visited.has(key)) { stop = "repeated-page"; break; }
    if (budget !== null && pages === MAX_PAGES) { stop = "page-budget"; break; }
    visited.add(key);
    const response: AwxResponse = await read(nextRoute, nextQuery);
    pages += 1;
    if (response.status < 200 || response.status >= 300) {
      throw errorForResponse(response, { subject: describeRoute(route) });
    }

    const page = readEnvelope(response.body);
    const remaining = rowLimit - rows.length;
    rows.push(...page.results.slice(0, remaining));
    count ??= page.count;
    partialPage = page.results.length > remaining;
    continuation = page.next ?? null;

    if (partialPage || (rows.length === rowLimit && page.next !== undefined)) { stop = "row-budget"; break; }
    if (page.next === undefined) { break; }
    if (page.results.length === 0) { stop = "empty-page"; break; }
    const parsed = splitUrl(page.next);
    nextRoute = parsed.route;
    nextQuery = parsed.query;
  }

  const pagination: PagedResult["pagination"] = {
    max_rows: budget?.maxRows ?? null, max_pages: budget === null ? null : MAX_PAGES, pages, stop,
    truncated: stop !== "complete", next: continuation,
    partial_page: partialPage,
  };
  if (budget === null && pagination.truncated) {
    throw new AwxAxiError(`Cannot summarize ${describeRoute(route)}: collection is incomplete`, "INCOMPLETE_COLLECTION", [], { count, pagination });
  }
  return { rows, count, pagination };
}

interface Envelope {
  readonly count: number | undefined;
  readonly next: string | undefined;
  readonly results: readonly unknown[];
}

export function readEnvelope(body: unknown): Envelope {
  if (body === null || typeof body !== "object") {
    throw new AxiError("the controller returned a list page with no envelope", "INVALID_RESPONSE");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new AxiError("the controller returned a list page with no results", "INVALID_RESPONSE");
  }

  return {
    count: typeof record.count === "number" ? record.count : undefined,
    next: typeof record.next === "string" ? record.next : undefined,
    results: record.results,
  };
}

/** Split AWX's own `next` link into the route and query a reader takes. */
function splitUrl(url: string): { route: string; query: Query } {
  const separator = url.indexOf("?");
  if (separator === -1) {
    return { route: url, query: {} };
  }

  const query: Query = {};
  for (const [key, value] of new URLSearchParams(url.slice(separator + 1))) {
    query[key] = value;
  }
  return { route: url.slice(0, separator), query };
}

/** A route is never printed to an agent, so this names the collection instead. */
function describeRoute(route: string): string {
  const segments = route.split("/").filter((segment) => segment.length > 0);
  return `the ${segments[segments.length - 1] ?? "list"} list`;
}
