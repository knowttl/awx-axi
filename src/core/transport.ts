/**
 * The transport seam (design.md §10.3).
 *
 * `post` is the only mutating method here, and that is the point: §2's
 * no-deletes property means there is no `del`, `put`, or `patch` method for any
 * command, retry path, or future contributor to call.
 */
import { AxiError } from "axi-sdk-js";

import { networkError } from "./errors.js";
import { walkPages } from "./paginate.js";

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
  /** Empty when `tooLarge`: the apology must never be mistaken for job output. */
  readonly content: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** AWX's `absolute_end`: the total line count (§8.4). */
  readonly absoluteEnd: number;
  readonly tooLarge: boolean;
  /** The two byte counts parsed out of the apology, when it was one. */
  readonly sizeBytes?: number;
  readonly displayLimitBytes?: number;
}

export type RiskTier = "operational" | "config" | "delete" | "security";

export interface AwxTransport {
  get(route: string, query?: Query): Promise<AwxResponse>;
  /** Refused with `READ_ONLY_VIOLATION` or safety gate when flags/env forbid it. */
  post(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse>;
  put(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse>;
  patch(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse>;
  delete(route: string, tag?: RiskTier): Promise<AwxResponse>;
  /** Takes the caller's row limit, not a page size; walks `next` itself. */
  getPaged(route: string, query: Query, limit: number): Promise<PagedResult>;
  getText(route: string, query?: Query): Promise<TextResponse>;
}

/** True when the §6.5 boundary is in force. */
export function isReadOnly(env: Record<string, string | undefined>): boolean {
  return env.AWX_AXI_READ_ONLY === "1";
}

/**
 * The safety boundary, in one place below every domain and every command.
 *
 * It throws before anything is issued, which is the whole guarantee: a promise
 * in a document is not an enforcement mechanism.
 */
export function assertWritable(
  envOrReadOnly: boolean | Record<string, string | undefined>,
  method: string,
  route: string,
  tag?: RiskTier,
): void {
  const env: Record<string, string | undefined> =
    typeof envOrReadOnly === "boolean"
      ? {
          ...(envOrReadOnly ? { AWX_AXI_READ_ONLY: "1" } : {}),
          ...(typeof process !== "undefined" ? process.env : {}),
        }
      : envOrReadOnly;

  if (isReadOnly(env)) {
    throw new AxiError(
      `refused ${method} ${route}: this session is read-only and nothing was sent`,
      "READ_ONLY_VIOLATION",
      ["Unset AWX_AXI_READ_ONLY to allow writes against this controller"],
    );
  }

  const effectiveTag: RiskTier =
    tag ??
    (method === "DELETE"
      ? "delete"
      : method === "PUT" || method === "PATCH"
        ? "config"
        : "operational");

  if (effectiveTag === "config" && env.AWX_AXI_ALLOW_CONFIG_WRITES !== "1") {
    throw new AxiError(
      `refused ${method} ${route}: configuration writes are disabled in this session`,
      "CONFIG_WRITES_DISABLED",
      ["Set AWX_AXI_ALLOW_CONFIG_WRITES=1 to allow configuration writes"],
    );
  }

  if (effectiveTag === "delete" && env.AWX_AXI_ALLOW_DELETES !== "1") {
    throw new AxiError(
      `refused ${method} ${route}: delete operations are disabled in this session`,
      "DELETE_WRITES_DISABLED",
      ["Set AWX_AXI_ALLOW_DELETES=1 to allow delete operations"],
    );
  }

  if (effectiveTag === "security" && env.AWX_AXI_ALLOW_SECURITY_WRITES !== "1") {
    throw new AxiError(
      `refused ${method} ${route}: security writes are disabled in this session`,
      "SECURITY_WRITES_DISABLED",
      ["Set AWX_AXI_ALLOW_SECURITY_WRITES=1 to allow security writes"],
    );
  }
}

/**
 * Recognize the oversized-stdout apology (§4.3 case 4).
 *
 * AWX answers a body above the 1 MiB display cap with **HTTP 200** whose
 * content is an English sentence and whose range is clamped to
 * `{start: 0, end: 1, absolute_end: 1}`. A client that trusts the status code
 * prints the apology as though it were playbook output.
 */
export function interpretText(response: AwxResponse): TextResponse {
  const { content, range } = readStdoutBody(response.body);
  const apology = APOLOGY.exec(content);

  if (apology === null) {
    return {
      status: response.status,
      content,
      rangeStart: range.start,
      rangeEnd: range.end,
      absoluteEnd: range.absoluteEnd,
      tooLarge: false,
    };
  }

  return {
    status: response.status,
    content: "",
    rangeStart: range.start,
    rangeEnd: range.end,
    absoluteEnd: range.absoluteEnd,
    tooLarge: true,
    sizeBytes: Number(apology[1]),
    displayLimitBytes: Number(apology[2]),
  };
}

const APOLOGY =
  /^Standard Output too large to display \((\d+) bytes\), only download supported for sizes over (\d+) bytes/;

function readStdoutBody(body: unknown): {
  content: string;
  range: { start: number; end: number; absoluteEnd: number };
} {
  if (typeof body === "string") {
    return { content: body, range: { start: 0, end: 0, absoluteEnd: 0 } };
  }
  if (body === null || typeof body !== "object") {
    return { content: "", range: { start: 0, end: 0, absoluteEnd: 0 } };
  }

  const record = body as Record<string, unknown>;
  const range = (record.range ?? {}) as Record<string, unknown>;
  return {
    content: typeof record.content === "string" ? record.content : "",
    range: {
      start: numberOr(range.start, 0),
      end: numberOr(range.end, 0),
      absoluteEnd: numberOr(range.absolute_end, 0),
    },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<Response>;

export interface HttpTransportOptions {
  /** Controller base URL, e.g. `https://awx.example.com`. */
  readonly baseUrl: string;
  /**
   * The API base path, `/api/v2/` at 24.6.1 and elsewhere on a gateway-fronted
   * controller (§4.2). Required, so no construction site can quietly ignore
   * `AWX_AXI_API_BASE_PATH`. Keeps its trailing slash: routes are declared
   * base-relative (`jobs/1839/`) and resolved against it exactly once.
   */
  readonly apiBasePath: string;
  /** The `Authorization` header value, when a credential resolved. */
  readonly authorization?: string;
  /** The §6.5 boundary and environment context. */
  readonly readOnly: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts for a retryable GET, including the first. */
  readonly attempts?: number;
}

/** The production transport: Node's native `fetch`, no client library (§12). */
export class HttpTransport implements AwxTransport {
  readonly #options: HttpTransportOptions;
  readonly #fetch: FetchLike;
  /**
   * `baseUrl` and `apiBasePath` joined once, here, so every route resolves
   * against the configured API root and no call site repeats it. A
   * base-relative route (`jobs/1839/`) lands under it, and AWX's own `next`
   * link - an absolute path - still replaces the path outright, which is what
   * keeps multi-page walking correct (§4.3 case 1).
   */
  readonly #apiRoot: URL;

  constructor(options: HttpTransportOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#apiRoot = new URL(options.apiBasePath, options.baseUrl);
  }

  async get(route: string, query: Query = {}): Promise<AwxResponse> {
    const attempts = this.#options.attempts ?? 3;
    let response = await this.#send("GET", route, query, undefined);

    for (let attempt = 1; attempt < attempts && isBusy(response.status); ) {
      await (this.#options.sleep ?? sleep)(200 * attempt);
      attempt += 1;
      response = await this.#send("GET", route, query, undefined);
    }

    return response;
  }

  #getEnv(): Record<string, string | undefined> | boolean {
    return this.#options.env ?? this.#options.readOnly;
  }

  /**
   * Mutating HTTP verbs. Environment gates and read-only checks run first
   * so no retry path, subcommand, or future contributor can bypass them.
   */
  async post(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "POST", route, tag);
    return this.#send("POST", route, {}, body);
  }

  async put(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "PUT", route, tag);
    return this.#send("PUT", route, {}, body);
  }

  async patch(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "PATCH", route, tag);
    return this.#send("PATCH", route, {}, body);
  }

  async delete(route: string, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "DELETE", route, tag);
    return this.#send("DELETE", route, {}, undefined);
  }

  async getPaged(
    route: string,
    query: Query,
    limit: number,
  ): Promise<PagedResult> {
    return walkPages((page, pageQuery) => this.get(page, pageQuery), route, query, limit);
  }

  async getText(route: string, query: Query = {}): Promise<TextResponse> {
    return interpretText(await this.get(route, query));
  }

  async #send(
    method: string,
    route: string,
    query: Query,
    body: unknown,
  ): Promise<AwxResponse> {
    const url = new URL(route, this.#apiRoot);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.#options.authorization !== undefined) {
      headers.Authorization = this.#options.authorization;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw networkError(cause, url.host);
    }

    return {
      status: response.status,
      headers: response.headers,
      body: await readBody(response),
    };
  }
}

function isBusy(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** One scripted response for {@link RecordedTransport}. */
export interface RecordedExchange {
  readonly status: number;
  readonly body?: unknown;
}

export interface RecordedRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly route: string;
  readonly query: Query;
  readonly body?: unknown;
  readonly tag?: RiskTier;
}

/**
 * The offline transport (§11.2). Not a mock: it is the second of the two real
 * implementations of the seam, replaying fixture bodies in order and recording
 * what was asked for so a test can assert on the wire.
 */
export class RecordedTransport implements AwxTransport {
  readonly requests: RecordedRequest[] = [];
  readonly #script: RecordedExchange[];
  readonly #readOnly: boolean;
  readonly #env: Record<string, string | undefined> | undefined;

  constructor(
    script: readonly RecordedExchange[],
    options: { readonly readOnly?: boolean; readonly env?: Record<string, string | undefined> } = {},
  ) {
    this.#script = [...script];
    this.#readOnly = options.readOnly ?? false;
    this.#env = options.env;
  }

  #getEnv(): Record<string, string | undefined> | boolean {
    return this.#env ?? this.#readOnly;
  }

  async get(route: string, query: Query = {}): Promise<AwxResponse> {
    return this.#next("GET", route, query, undefined);
  }

  async post(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "POST", route, tag);
    return this.#next("POST", route, {}, body, tag);
  }

  async put(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "PUT", route, tag);
    return this.#next("PUT", route, {}, body, tag);
  }

  async patch(route: string, body?: unknown, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "PATCH", route, tag);
    return this.#next("PATCH", route, {}, body, tag);
  }

  async delete(route: string, tag?: RiskTier): Promise<AwxResponse> {
    assertWritable(this.#getEnv(), "DELETE", route, tag);
    return this.#next("DELETE", route, {}, undefined, tag);
  }

  async getPaged(
    route: string,
    query: Query,
    limit: number,
  ): Promise<PagedResult> {
    return walkPages((page, pageQuery) => this.get(page, pageQuery), route, query, limit);
  }

  async getText(route: string, query: Query = {}): Promise<TextResponse> {
    return interpretText(await this.get(route, query));
  }

  #next(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    query: Query,
    body: unknown,
    tag?: RiskTier,
  ): Promise<AwxResponse> {
    this.requests.push({
      method,
      route,
      query,
      ...(body === undefined ? {} : { body }),
      ...(tag === undefined ? {} : { tag }),
    });

    const exchange = this.#script.shift();
    if (exchange === undefined) {
      throw new Error(
        `RecordedTransport has no scripted response for ${method} ${route}`,
      );
    }

    return Promise.resolve({
      status: exchange.status,
      headers: new Headers(),
      body: exchange.body,
    });
  }
}
