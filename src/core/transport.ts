/**
 * The transport seam (design.md §10.3). Types only: `HttpTransport` and
 * `RecordedTransport` are a later task.
 *
 * `post` is the only mutating method here, and that is the point: §2's
 * no-deletes property means there is no `del`, `put`, or `patch` method for any
 * command, retry path, or future contributor to call.
 */

/** Query parameters for a read. Values are serialized by the implementation. */
export type Query = Record<string, string | number | boolean>;

export interface AwxResponse {
  /** Load-bearing: 202, 204, 400, and 405 all carry meaning (§3.2, §9.2). */
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON, or `undefined` for a 204. */
  readonly body: unknown;
}

/** One assembled read, plus the server's own total from the envelope (§10.3). */
export interface PagedResult {
  readonly rows: readonly unknown[];
  /** AWX's `count`. Never inferred from the rows returned (§4.3 case 2). */
  readonly count: number | undefined;
}

/** A stdout read. The oversized-output apology is a typed condition (§4.3 case 4). */
export interface TextResponse {
  readonly status: number;
  readonly content: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** AWX's `absolute_end`: the total line count (§8.4). */
  readonly absoluteEnd: number;
  readonly tooLarge: boolean;
}

export interface AwxTransport {
  get(route: string, query?: Query): Promise<AwxResponse>;
  /** Refused with `READ_ONLY_VIOLATION` when the §6.5 flag is set. */
  post(route: string, body?: unknown): Promise<AwxResponse>;
  /** Takes the caller's row limit, not a page size; walks `next` itself. */
  getPaged(route: string, query: Query, limit: number): Promise<PagedResult>;
  getText(route: string, query?: Query): Promise<TextResponse>;
}
