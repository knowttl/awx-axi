/**
 * Id-or-name resolution (design.md §7.3) and unified-job type resolution
 * (§7.2).
 *
 * Names resolve by **filtered query, never by named URL**: a named-URL 403 is
 * rewritten to `Not found.` so a named lookup cannot tell "does not exist" from
 * "you cannot see it" (§4.3 case 5), and named URL formats vary per controller.
 * A filtered query returns a count, which is what makes the three outcomes
 * below distinguishable and the ambiguous one reportable.
 */
import { AxiError } from "axi-sdk-js";

import { AwxAxiError, errorForResponse } from "./errors.js";
import { read, type Plan } from "./registry.js";

export interface ResolveOptions {
  /** The list route to filter, base-relative, e.g. `job_templates/`. */
  readonly listRoute: string;
  /** Singular noun for the messages, e.g. `job template`. */
  readonly noun: string;
  /** The `list` command an agent should run to search, e.g. `template list`. */
  readonly listCommand: string;
  /**
   * The subcommand doing the resolving, e.g. `template launch`. Carried so the
   * `AMBIGUOUS_NAME` help line is a complete runnable command rather than a
   * shape the agent has to reassemble (§7.3, AXI §9).
   */
  readonly command: string;
}

/**
 * Resolve an `<id|name>` argument to an id.
 *
 * A numeric argument costs no request at all; a name costs exactly one filtered
 * read, or two when the exact match finds nothing and the case-insensitive
 * fallback is tried (§7.10).
 */
export function* resolveId(
  value: string,
  options: ResolveOptions,
): Plan<number> {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  let page = yield* matchName(value, "name", options);
  if (page.matches.length === 0) {
    page = yield* matchName(value, "name__iexact", options);
  }

  const matches = page.matches;
  if (matches.length === 0) {
    throw new AxiError(
      `no ${options.noun} is named "${value}"`,
      "NAME_NOT_FOUND",
      [
        `Run \`awx-axi ${options.listCommand} --search "${value}"\` to search by partial name`,
        `A ${options.noun} this account cannot see looks identical to one that does not exist`,
      ],
    );
  }

  const first = matches[0] as NamedObject;
  if (matches.length === 1) {
    return first.id;
  }

  // AWX itself returns the oldest match for a legacy bare-name lookup. awx-axi
  // refuses instead: silently picking one of two production templates is the
  // exact failure AXI §6 exists to prevent (§7.3).
  //
  // The total comes from the envelope's own `count`, which is the whole reason
  // §7.3 resolves by filtered query: with more same-named objects than the
  // controller's page size, the rows on hand are one page and saying so is the
  // only honest report.
  const total = page.count ?? matches.length;
  const partial = total > matches.length;

  throw new AwxAxiError(
    `${total} ${options.noun}s are named "${value}"`,
    "AMBIGUOUS_NAME",
    [
      `Re-run with the id, e.g. \`awx-axi ${options.command} ${first.id}\``,
      ...(partial
        ? [
            `Only ${matches.length} of the ${total} candidates are listed above; run \`awx-axi ${options.listCommand} --search "${value}"\` for the rest`,
          ]
        : []),
    ],
    { candidates: matches },
  );
}

interface NamedObject {
  readonly id: number;
  readonly name: string;
  readonly organization: string;
}

/** One filtered page: the rows it carried, and the server's own total. */
interface NameMatches {
  readonly matches: NamedObject[];
  /** AWX's `count`. Never inferred from the rows returned (§4.3 case 2). */
  readonly count: number | undefined;
}

function* matchName(
  value: string,
  lookup: "name" | "name__iexact",
  options: ResolveOptions,
): Plan<NameMatches> {
  const response = yield* read(options.listRoute, { [lookup]: value });
  if (response.status !== 200) {
    throw errorForResponse(response, {
      subject: `${options.noun} "${value}"`,
    });
  }

  const envelope = (response.body ?? {}) as {
    results?: unknown;
    count?: unknown;
  };
  return {
    matches: Array.isArray(envelope.results)
      ? envelope.results.map(toNamedObject)
      : [],
    count: typeof envelope.count === "number" ? envelope.count : undefined,
  };
}

function toNamedObject(row: unknown): NamedObject {
  const record = (row ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const organization = (summary.organization ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    organization:
      typeof organization.name === "string" ? organization.name : "",
  };
}

/** What one unified-job row says about a run, whatever kind it is. */
export interface UnifiedJob {
  readonly id: number;
  /** AWX's own type, e.g. `job`, `workflow_job`, `project_update`. */
  readonly type: string;
  readonly name: string;
  readonly status: string;
}

/**
 * `/api/v2/unified_jobs/` has no detail endpoint, so `job show 1839` needs the
 * concrete type before it can pick `/api/v2/jobs/1839/` over
 * `/api/v2/workflow_jobs/1839/`. One filtered list read buys it; `--type` skips
 * this request entirely (§7.2, §7.10).
 */
export function* resolveUnifiedJob(id: number): Plan<UnifiedJob> {
  const response = yield* read("unified_jobs/", { id });
  if (response.status !== 200) {
    throw errorForResponse(response, { subject: `job ${id}` });
  }

  const results = (response.body as { results?: unknown } | null)?.results;
  const row = Array.isArray(results) ? results[0] : undefined;

  if (row === undefined) {
    throw new AxiError(`no job with id ${id} on this controller`, "NOT_FOUND", [
      "Run `awx-axi job list --type all` to see recent runs of every kind",
    ]);
  }

  const record = row as Record<string, unknown>;
  return {
    id,
    type: typeof record.type === "string" ? record.type : "",
    name: typeof record.name === "string" ? record.name : "",
    status: typeof record.status === "string" ? record.status : "",
  };
}
