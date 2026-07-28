/**
 * Envelope walking (design.md §4.3 cases 1-3, §10.3).
 *
 * The caller states how many rows it wants; this module turns that into as many
 * page reads as AWX requires and hands back one assembled result plus the
 * server's own `count`, so no domain and no command ever sees a page boundary.
 */
import { errorForResponse } from "./errors.js";
import type { AwxResponse, PagedResult, Query } from "./transport.js";

/** A single page read, injected so both transports share one walk. */
export type PageReader = (route: string, query: Query) => Promise<AwxResponse>;

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
 * Walk `next` until the caller's row limit is met.
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
  limit: number,
): Promise<PagedResult> {
  assertNoCountDisabled(query);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`row limit must be a positive integer, got ${limit}`);
  }

  const rows: unknown[] = [];
  let count: number | undefined;
  let nextRoute: string | undefined = route;
  let nextQuery: Query = { ...query, page_size: limit };

  while (nextRoute !== undefined && rows.length < limit) {
    const response: AwxResponse = await read(nextRoute, nextQuery);
    if (response.status < 200 || response.status >= 300) {
      throw errorForResponse(response, { subject: describeRoute(route) });
    }

    const page = readEnvelope(response.body);
    rows.push(...page.results);
    count ??= page.count;

    if (page.next === undefined || page.results.length === 0) {
      break;
    }
    const parsed = splitUrl(page.next);
    nextRoute = parsed.route;
    nextQuery = parsed.query;
  }

  return { rows: rows.slice(0, limit), count };
}

interface Envelope {
  readonly count: number | undefined;
  readonly next: string | undefined;
  readonly results: readonly unknown[];
}

function readEnvelope(body: unknown): Envelope {
  if (body === null || typeof body !== "object") {
    throw new Error("the controller returned a list page with no envelope");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new Error("the controller returned a list page with no results");
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
