/**
 * The domain contract (design.md §10.2). Types only: the shared list/detail
 * pipeline this registry will also hold is a later task.
 *
 * A domain module never speaks HTTP and never imports another domain. It
 * declares five things - subcommands with their flag sets, route descriptions,
 * TOON field schemas, contextual-disclosure suggestions, and `mcpEquivalents` -
 * and the core owns everything else.
 */
import type { Query } from "./transport.js";

/**
 * What a handler may return to the CLI loop: a string, written through
 * verbatim, or an object, TOON-encoded (§8, §8.4). Declared here because the
 * SDK's own `AxiRenderable` is not importable at the pinned 0.1.8 (§16).
 */
export type Renderable = string | Record<string, unknown>;

/** Everything a domain needs from the core. */
export interface DomainContext {
  readonly env: Record<string, string | undefined>;
}

/**
 * A route a subcommand needs, returned as data rather than executed, which is
 * what makes a domain unit-testable with no network.
 *
 * **There is no verb field, and its absence is the design.** §2's no-deletes
 * property is expressed here in the type system rather than in review: a domain
 * cannot describe a `DELETE` because a route description cannot carry a method.
 */
export interface RouteDescription {
  readonly path: string;
  readonly query?: Query;
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

export interface SubcommandSpec {
  readonly name: string;
  /** Concise per-subcommand `--help`: flags, arguments, and 2-3 examples (§10 of the AXI skill). */
  readonly help: string;
  readonly flags: readonly FlagSpec[];
  readonly route: (args: readonly string[]) => RouteDescription;
  readonly schema: FieldSchema;
  readonly suggestions: readonly SuggestionRule[];
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
  run(args: string[], context: DomainContext): Promise<Renderable>;
}
