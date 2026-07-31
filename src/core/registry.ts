/**
 * The domain contract (design.md §10.2), and the shared pipeline that runs it.
 *
 * A domain module never speaks HTTP and never imports another domain. It
 * declares five things - subcommands with their flag sets, the requests each
 * one needs, TOON field schemas, contextual-disclosure suggestions, and
 * `mcpEquivalents` - and the core owns everything else.
 */
import { validationError } from "./errors.js";
import {
  assertNoSecretFlags,
  assertUsableArity,
  parseFlags,
  type ParsedFlags,
  type PositionalSpec,
} from "./flags.js";
import type {
  AwxResponse,
  AwxTransport,
  PagedResult,
  Query,
  RiskTier,
  TextResponse,
} from "./transport.js";

/**
 * What a handler may return to the CLI loop: a string, written through
 * verbatim, or an object, TOON-encoded (§8, §8.4). Declared here because the
 * SDK's own `AxiRenderable` is not importable at the pinned 0.1.8 (§16).
 */
export type Renderable = string | Record<string, unknown>;

const EXIT_CODE = Symbol("awx-axi.exitCode");

/**
 * A renderable plus the exit code the CLI must exit with (§10.2).
 *
 * §7.9 requires `job watch` to exit 1 when the watched job ended `failed`,
 * `error`, or `canceled` **while still printing the job block**, so throwing an
 * `AxiError` is the wrong mechanism: the command worked and is reporting bad
 * news, and an error block is not what it did. This is the whole channel: there
 * is no outcome taxonomy above it.
 */
export interface ExitCodeResult {
  readonly [EXIT_CODE]: number;
  readonly output: Renderable;
}

/** What a subcommand's plan may return: a renderable, or one plus an exit code. */
export type DomainResult = Renderable | ExitCodeResult;

/** Report `output` and exit with `exitCode`, rather than rendering an error. */
export function withExitCode(
  output: Renderable,
  exitCode: number,
): ExitCodeResult {
  return { [EXIT_CODE]: exitCode, output };
}

/** Split a domain result into what to render and what to exit with. */
export function splitResult(result: DomainResult): {
  output: Renderable;
  exitCode: number;
} {
  if (typeof result === "object" && EXIT_CODE in result) {
    const wrapped = result as ExitCodeResult;
    return { output: wrapped.output, exitCode: wrapped[EXIT_CODE] };
  }
  return { output: result as Renderable, exitCode: 0 };
}

/** Everything a domain needs from the core. */
export interface DomainContext {
  readonly env: Record<string, string | undefined>;
  /**
   * Built lazily, so `--help` and flag validation never need a credential.
   * Throws `AUTH_REQUIRED` when nothing resolves (§5.1).
   */
  createTransport(): AwxTransport;
  /**
   * Injected by the offline suite so the §7.9 backoff costs no wall-clock
   * time. Unset in production, where a declared delay really waits.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * A route a subcommand needs, returned as data rather than executed, which is
 * what makes a domain unit-testable with no network.
 *
 * Route descriptions represent read-only requests and carry no HTTP verb.
 */
export interface RouteDescription {
  readonly path: string;
  readonly query?: Query;
}

export type HttpMutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One request a subcommand declares, as data.
 *
 * `write` requests support `method` ("POST" | "PUT" | "PATCH" | "DELETE") and risk tier tags.
 */
export type AwxRequest =
  | { readonly kind: "read"; readonly route: RouteDescription }
  | {
      readonly kind: "readPaged";
      readonly route: RouteDescription;
      /** Rows the caller wants, not a page size (§10.3). */
      readonly limit: number;
    }
  | { readonly kind: "readText"; readonly route: RouteDescription }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly method?: HttpMutationMethod;
      readonly body?: unknown;
      readonly tag?: RiskTier;
    }
  | { readonly kind: "delay"; readonly ms: number };

export type RequestResult =
  | AwxResponse
  | PagedResult
  | TextResponse
  | undefined;

/**
 * A subcommand's requests, declared as a resumable sequence.
 *
 * This is the answer to "a subcommand is not one request": `job show` is three
 * or four, and `template launch "Deploy web tier"` cannot build its launch path
 * until the resolve response comes back. A plan yields a request description
 * and is resumed with that request's result, so a later route may depend on an
 * earlier response while the domain still executes nothing itself.
 *
 * A test drives a plan by handing it fixture results directly, or through
 * `RecordedTransport` - either way with no network and no mocking framework.
 */
export type Plan<T> = Generator<AwxRequest, T, RequestResult>;

/**
 * A domain-declared route is **base-relative**: `jobs/1839/`, never
 * `/api/v2/jobs/1839/`. `HttpTransport` joins it onto the configured API root
 * once, so a leading slash would escape that root and send the request to the
 * server's own top level.
 *
 * A leading slash resolves identically under the default `/api/v2/`, so nothing
 * at 24.6.1 would notice - it would only break under an `AWX_AXI_API_BASE_PATH`
 * override, silently. That silence is why the invariant is enforced here, in
 * the four helpers every domain-declared route passes through, rather than in
 * prose. AWX's own absolute `next` links are unaffected: `walkPages` follows
 * them directly and never goes through these helpers.
 */
function assertBaseRelative(path: string): void {
  if (path.startsWith("/")) {
    throw new Error(
      `route "${path}" must be base-relative: drop the leading slash so it resolves under the configured API root (design.md §4.2)`,
    );
  }
}

/** Declare a single read. */
export function* read(path: string, query?: Query): Plan<AwxResponse> {
  assertBaseRelative(path);
  const result = yield {
    kind: "read",
    route: query === undefined ? { path } : { path, query },
  };
  return result as AwxResponse;
}

/** Declare a read of up to `limit` rows, however many pages that takes. */
export function* readPaged(
  path: string,
  query: Query,
  limit: number,
): Plan<PagedResult> {
  assertBaseRelative(path);
  const result = yield { kind: "readPaged", route: { path, query }, limit };
  return result as PagedResult;
}

/** Declare a stdout read, including the §4.3 case 4 oversized condition. */
export function* readText(path: string, query?: Query): Plan<TextResponse> {
  assertBaseRelative(path);
  const result = yield {
    kind: "readText",
    route: query === undefined ? { path } : { path, query },
  };
  return result as TextResponse;
}

export interface WriteOptions {
  readonly method?: HttpMutationMethod | undefined;
  readonly tag?: RiskTier | undefined;
}

/**
 * Declare a mutating request a domain may express. Refused before
 * anything is issued when safety gates or read-only flags forbid it.
 */
export function* write(
  path: string,
  body?: unknown,
  options?: WriteOptions | HttpMutationMethod,
  tag?: RiskTier,
): Plan<AwxResponse> {
  assertBaseRelative(path);
  const opts: WriteOptions =
    typeof options === "string"
      ? { method: options, tag }
      : { tag, ...options };
  const method = opts.method ?? "POST";
  const riskTag = opts.tag;
  const result = yield {
    kind: "write",
    path,
    method,
    ...(body === undefined ? {} : { body }),
    ...(riskTag === undefined ? {} : { tag: riskTag }),
  };
  return result as AwxResponse;
}

/** Declare a wait. Issues nothing; used by the §7.9 poll loop. */
export function* delay(ms: number): Plan<void> {
  yield { kind: "delay", ms };
}

export interface PlanRunner {
  readonly transport: AwxTransport;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Execute a declared plan against the seam. The only place requests are issued. */
export async function runPlan<T>(
  plan: Plan<T>,
  runner: PlanRunner,
): Promise<T> {
  let step = plan.next();

  while (!step.done) {
    step = plan.next(await execute(step.value, runner));
  }

  return step.value;
}

async function execute(
  request: AwxRequest,
  runner: PlanRunner,
): Promise<RequestResult> {
  switch (request.kind) {
    case "read":
      return runner.transport.get(request.route.path, request.route.query);
    case "readPaged":
      return runner.transport.getPaged(
        request.route.path,
        request.route.query ?? {},
        request.limit,
      );
    case "readText":
      return runner.transport.getText(request.route.path, request.route.query);
    case "write": {
      const method = request.method ?? "POST";
      switch (method) {
        case "POST":
          return runner.transport.post(request.path, request.body, request.tag);
        case "PUT":
          return runner.transport.put(request.path, request.body, request.tag);
        case "PATCH":
          return runner.transport.patch(request.path, request.body, request.tag);
        case "DELETE":
          return runner.transport.delete(request.path, request.tag);
        default:
          return runner.transport.post(request.path, request.body, request.tag);
      }
    }
    case "delay":
      await (runner.sleep ?? realSleep)(request.ms);
      return undefined;
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A flag a subcommand accepts, consumed by `core/flags.ts`'s validation (§9.4). */
export interface FlagSpec {
  readonly name: string;
  readonly description: string;
  /** `false` for a boolean flag such as `--failed`. */
  readonly takesValue: boolean;
}

/** A subcommand's TOON output shape, including the `--fields` allowlist (§8.2). */
export interface FieldSchema {
  /** TOON collection label, e.g. `jobs`. */
  readonly label: string;
  readonly defaultFields: readonly string[];
  /** Field names `--fields` may add, beyond the default schema. */
  readonly fieldAllowlist: readonly string[];
}

/**
 * One row of a domain's contextual-disclosure match table (§9 of the AXI
 * skill): the outcome it applies to, and the complete commands to suggest.
 */
export interface SuggestionRule {
  /** The outcome this row matches, e.g. `empty`, `failed`, `launched`. */
  readonly outcome: string;
  readonly suggestions: readonly string[];
}

/** What a subcommand's plan is handed. */
export interface SubcommandInput {
  /** Positional arguments after the subcommand name, e.g. an id or a name. */
  readonly args: readonly string[];
  readonly flags: ParsedFlags;
  readonly context: DomainContext;
}

export interface SubcommandSpec {
  readonly name: string;
  /** Concise per-subcommand `--help`: flags, arguments, and 2-3 examples (§10 of the AXI skill). */
  readonly help: string;
  readonly flags: readonly FlagSpec[];
  /**
   * The positional arguments this subcommand accepts, as one range (§9.4).
   * Declared rather than inferred because both ends are the same failure as an
   * unknown flag: `cancel 1839 1841` that cancels only 1839 and reports success
   * is worse than an error, and `cancel` with no id would build a mutating
   * request out of nothing (AXI §6).
   */
  readonly positionals: PositionalSpec;
  readonly schema: FieldSchema;
  readonly suggestions: readonly SuggestionRule[];
  /** The requests this subcommand needs, declared as data (§10.2). */
  plan(input: SubcommandInput): Plan<DomainResult>;
}

/**
 * A registered noun. Adding a domain is one new directory under `src/domains/`
 * plus one entry in `DOMAINS` in `src/cli.ts`: no core change, no cross-domain
 * edit.
 */
export interface Domain {
  readonly name: string;
  /** Noun-level `--help`. */
  readonly help: string;
  readonly subcommands: readonly SubcommandSpec[];
  /** The awx-mcp tool names this domain covers, read by §14.2's coverage tool. */
  readonly mcpEquivalents: readonly string[];
  /** Dispatch to a subcommand through the core pipeline. Issues no request itself. */
  run(args: string[], context: DomainContext): Promise<DomainResult>;
}

export type DomainSpec = Omit<Domain, "run">;

/**
 * Build the `run` a domain registers, so subcommand dispatch, flag validation,
 * and plan execution are written once (§10.2).
 *
 * The §5.3 secret-name guard fires here, at module load, because a domain is
 * constructed when it is imported: adding `--token` fails the build rather than
 * shipping a secret through `argv`.
 */
export function defineDomain(spec: DomainSpec): Domain {
  for (const subcommand of spec.subcommands) {
    assertNoSecretFlags(`${spec.name} ${subcommand.name}`, subcommand.flags);
    assertUsableArity(`${spec.name} ${subcommand.name}`, subcommand.positionals);
  }

  return {
    ...spec,
    async run(args, context) {
      const name = args[0];
      const subcommand = spec.subcommands.find(
        (candidate) => candidate.name === name,
      );

      if (subcommand === undefined) {
        throw validationError(
          name === undefined
            ? `\`awx-axi ${spec.name}\` needs a subcommand`
            : `unknown subcommand \`${spec.name} ${name}\``,
          [
            `valid subcommands for \`awx-axi ${spec.name}\`: ${spec.subcommands
              .map((candidate) => candidate.name)
              .join(", ")}`,
          ],
        );
      }

      const parsed = parseFlags(
        `${spec.name} ${subcommand.name}`,
        args.slice(1),
        subcommand.flags,
        subcommand.positionals,
      );

      return runPlan(
        subcommand.plan({
          args: parsed.args,
          flags: parsed.flags,
          context,
        }),
        {
          transport: context.createTransport(),
          ...(context.sleep === undefined ? {} : { sleep: context.sleep }),
        },
      );
    },
  };
}
