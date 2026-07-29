/**
 * Status-plus-body to `AxiError` translation (design.md §9, §9.1, §9.3).
 *
 * Raw AWX payloads never reach stdout: every message and every suggestion this
 * module produces names `awx-axi` commands only, never `awx` and never a REST
 * route.
 */
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";

/**
 * The four codes that exit 2 (§9). `exitCodeForError` from the SDK maps only
 * the literal `VALIDATION_ERROR`, which is why awx-axi passes its own
 * `formatError` to `runAxiCli` rather than collapsing the other three: the
 * stable code is the part an agent branches on.
 */
export const USAGE_ERROR_CODES: readonly string[] = [
  "VALIDATION_ERROR",
  "AMBIGUOUS_NAME",
  "LAUNCH_WOULD_IGNORE_INPUT",
  "LAUNCH_INPUT_REQUIRED",
];

/**
 * An `AxiError` that also carries the extra TOON blocks §7.3 and §7.5 print -
 * `candidates`, `ignored` - which the SDK's own error shape has no room for.
 * Rendered between `code:` and `help[N]:` by {@link formatError}.
 */
export class AwxAxiError extends AxiError {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    code: string,
    suggestions: string[] = [],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, code, suggestions);
    this.details = details;
  }
}

/** The `formatError` awx-axi hands to `runAxiCli` (§9). */
export function formatError(error: unknown): {
  output: string;
  exitCode: number;
} {
  if (error instanceof AxiError) {
    const details =
      error instanceof AwxAxiError ? error.details : ({} as const);
    const output: Record<string, unknown> = {
      error: error.message,
      code: error.code,
      ...details,
    };
    if (error.suggestions.length > 0) {
      output.help = error.suggestions;
    }
    return {
      output: `${encode(output)}\n`,
      exitCode: USAGE_ERROR_CODES.includes(error.code) ? 2 : 1,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${encode({ error: message, code: "UNKNOWN" })}\n`,
    exitCode: 1,
  };
}

export function validationError(
  message: string,
  suggestions: string[] = [],
): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

/** Everything a status-to-error mapping needs from its caller. */
export interface ResponseErrorContext {
  /** What the request was about, e.g. `job 1839`. Never a REST route. */
  readonly subject: string;
  readonly help?: readonly string[];
  /** Per-status code overrides, e.g. `{ 400: "LAUNCH_REJECTED" }` (§9.1). */
  readonly codes?: Readonly<Record<number, string>>;
}

const DEFAULT_CODES: Readonly<Record<number, string>> = {
  400: "VALIDATION_ERROR",
  401: "AUTH_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  500: "SERVER_ERROR",
  502: "SERVER_BUSY",
  503: "SERVER_BUSY",
  504: "SERVER_BUSY",
};

const DEFAULT_HELP: Readonly<Record<string, readonly string[]>> = {
  AUTH_REQUIRED: ["Run `awx-axi auth login` to store a token"],
  FORBIDDEN: ["Run `awx-axi auth status` to see which account is in use"],
};

/** Map one non-2xx response to the §9.1 table. */
export function errorForResponse(
  response: { readonly status: number; readonly body: unknown },
  context: ResponseErrorContext,
): AxiError {
  const code =
    context.codes?.[response.status] ??
    DEFAULT_CODES[response.status] ??
    "UNKNOWN";
  const detail = describeAwxBody(response.body, response.status);
  const message =
    detail === undefined
      ? `${context.subject}: ${defaultSummary(code, response.status)}`
      : `${context.subject}: ${detail}`;
  const help = context.help ?? DEFAULT_HELP[code] ?? [];

  return new AxiError(message, code, [...help]);
}

function defaultSummary(code: string, status: number): string {
  switch (code) {
    case "AUTH_REQUIRED":
      return "the controller rejected the credential";
    case "FORBIDDEN":
      return "this account is not permitted to do that";
    case "NOT_FOUND":
      return "no such object on this controller";
    case "SERVER_BUSY":
      return "the controller is not accepting requests right now";
    case "SERVER_ERROR":
      return "the controller failed to handle the request";
    default:
      return `the controller answered ${status} with no explanation`;
  }
}

/**
 * AWX's three body shapes, translated rather than passed through (§9.3): a
 * field-error dict `{"field": ["message"]}`, the non-field key `__all__`, and a
 * permission `{"detail": "..."}`. Anything else yields `undefined` so the
 * caller states its own summary instead of leaking a payload.
 *
 * The field-error form is read **only on a 400**, which is the only status AWX
 * produces it for. Without that gate a 500's traceback dict reads as a field
 * error and lands on stdout, which is exactly the dependency noise AXI §6
 * forbids.
 *
 * A bare string is **not** one of the three shapes and is never described: the
 * transport hands back raw text whenever the body would not parse as JSON, so
 * describing it would put a Django `DEBUG=False` error page on stdout - the same
 * leak the 400 gate above exists to close.
 */
export function describeAwxBody(
  body: unknown,
  status = 400,
): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "string") {
    return detail;
  }

  if (status !== 400) {
    return undefined;
  }

  const parts: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    const messages = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string"
        ? [value]
        : [];
    if (messages.length === 0) {
      continue;
    }
    parts.push(
      field === "__all__"
        ? messages.join("; ")
        : `${field}: ${messages.join("; ")}`,
    );
  }

  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Node's `fetch` failures, split into the two codes an operator can act on
 * (§9.1). Everything else stays `CONTROLLER_UNREACHABLE`, because a client that
 * cannot reach the controller is the same problem whatever the errno.
 */
export function networkError(cause: unknown, host: string): AxiError {
  const code = errnoOf(cause);

  if (code !== undefined && TLS_CODES.some((tls) => code.includes(tls))) {
    return new AxiError(
      `the certificate presented by ${host} could not be verified`,
      "TLS_UNTRUSTED",
      [
        "Set CONTROLLER_VERIFY_SSL=false to trust this controller's certificate",
      ],
    );
  }

  return new AxiError(`${host} could not be reached`, "CONTROLLER_UNREACHABLE", [
    "Run `awx-axi auth status` to see which controller is configured",
  ]);
}

const TLS_CODES: readonly string[] = [
  "CERT_",
  "SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS",
];

function errnoOf(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
