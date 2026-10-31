/**
 * The `host` domain: inspect managed hosts across visible inventories.
 *
 * Host creation and mutation remain under `inventory`; this noun is read-only.
 */
import { AxiError } from "axi-sdk-js";
import { encode } from "@toon-format/toon";

import { AwxAxiError, errorForResponse, validationError } from "../../core/errors.js";
import { pageBudget, PAGINATION_FLAGS, PAGINATION_HELP } from "../../core/paginate.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
import { redactValue } from "../../core/redact.js";
import {
  defineDomain,
  read,
  readPaged,
  withExitCode,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";
import type { Query, ReadBudget } from "../../core/transport.js";

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "hosts",
  defaultFields: [
    "id",
    "name",
    "inventory",
    "organization",
    "enabled",
    "instance_id",
    "has_active_failures",
    "has_inventory_sources",
  ],
  fieldAllowlist: [],
} as const;

type RecordValue = Record<string, unknown>;

type HostMatch = {
  readonly id: number;
  readonly name: string;
  readonly inventory: string | null;
  readonly organization: string | null;
};

type NameMatches = {
  readonly matches: HostMatch[];
  readonly count: number | undefined;
};

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function booleanOrFalse(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function formatReference(id: number | null, name: string | null): string | null {
  if (id === null && name === null) {
    return null;
  }
  if (id === null) {
    return name;
  }
  return name === null ? String(id) : `${id} (${name})`;
}

function inventoryContext(raw: unknown): {
  readonly inventory: string | null;
  readonly organization: string | null;
} {
  const host = record(raw);
  const summary = record(host.summary_fields);
  const inventory = record(summary.inventory);
  const inventoryId = numberOrNull(inventory.id) ?? numberOrNull(host.inventory);
  const inventoryName = stringOrNull(inventory.name);
  const organization = record(inventory.organization);
  const organizationId =
    numberOrNull(organization.id) ?? numberOrNull(inventory.organization_id);
  const organizationName = stringOrNull(organization.name);

  return {
    inventory: formatReference(inventoryId, inventoryName),
    organization: formatReference(organizationId, organizationName),
  };
}

function toHostRow(raw: unknown): Row {
  const host = record(raw);
  const context = inventoryContext(host);

  return {
    id: numberOrNull(host.id) ?? 0,
    name: stringOrNull(host.name),
    inventory: context.inventory,
    organization: context.organization,
    enabled: booleanOrFalse(host.enabled),
    instance_id: stringOrNull(host.instance_id),
    has_active_failures: booleanOrFalse(host.has_active_failures),
    has_inventory_sources: booleanOrFalse(host.has_inventory_sources),
  };
}

function toHostMatch(raw: unknown): HostMatch {
  const host = record(raw);
  const row = toHostRow(host);
  return {
    id: typeof row.id === "number" ? row.id : 0,
    name: typeof row.name === "string" ? row.name : "",
    inventory: typeof row.inventory === "string" ? row.inventory : null,
    organization: typeof row.organization === "string" ? row.organization : null,
  };
}

function toGroup(raw: unknown): RecordValue {
  const group = record(raw);
  const summary = record(group.summary_fields);
  const inventory = record(summary.inventory);
  return {
    id: numberOrNull(group.id),
    name: stringOrNull(group.name),
    inventory: formatReference(
      numberOrNull(inventory.id) ?? numberOrNull(group.inventory),
      stringOrNull(inventory.name),
    ),
  };
}

function parseInventory(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(`--inventory must be a positive integer, got ${raw}`, [
      "Run `awx-axi host list --inventory <id>`",
    ]);
  }
  return value;
}

function* matchHostName(
  value: string,
  lookup: "name" | "name__iexact",
  inventory?: number,
  budget?: ReadBudget,
): Plan<NameMatches> {
  const response = yield* read("hosts/", { [lookup]: value, ...(inventory === undefined ? {} : { inventory }) }, budget);
  if (response.status !== 200) {
    throw errorForResponse(response, { subject: `host "${value}"` });
  }

  const body = record(response.body);
  const results = Array.isArray(body.results) ? body.results : [];
  return {
    matches: results.map(toHostMatch),
    count: typeof body.count === "number" ? body.count : undefined,
  };
}

function* resolveHost(value: string, inventory?: number, budget?: ReadBudget): Plan<number> {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  let page = yield* matchHostName(value, "name", inventory, budget);
  if (page.matches.length === 0) {
    page = yield* matchHostName(value, "name__iexact", inventory, budget);
  }

  if (page.matches.length === 0) {
    throw new AxiError(
      `no host is named "${value}"`,
      "NAME_NOT_FOUND",
      [
        `Run \`awx-axi host list --search "${value}"\` to search by partial name`,
        "A host this account cannot see looks identical to one that does not exist",
      ],
    );
  }

  const total = page.count ?? page.matches.length;
  if (total === 1 && page.matches.length === 1) {
    return page.matches[0]!.id;
  }

  const partial = total > page.matches.length;
  const first = page.matches[0]!;
  throw new AwxAxiError(
    `${total} hosts are named "${value}"`,
    "AMBIGUOUS_NAME",
    [
      `Re-run with the id, e.g. \`awx-axi host show ${first.id}\``,
      ...(partial
        ? [
            `Only ${page.matches.length} of the ${total} candidates are listed above; run \`awx-axi host list --search "${value}"\` for the rest`,
          ]
        : []),
    ],
    { candidates: page.matches },
  );
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const query: Query = {};
  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.name === "string") {
    query.name = input.flags.name;
  }
  if (typeof input.flags.inventory === "string") {
    query.inventory = parseInventory(input.flags.inventory);
  }

  const limit = pageBudget(input.flags, DEFAULT_LIST_LIMIT);
  const paged = yield* readPaged("hosts/", query, limit);
  const rows = paged.rows.map(toHostRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    pagination: paged.pagination,
    empty: "0 hosts found",
    help: [
      "Run `awx-axi host show <id|name>` for host detail",
      "Run `awx-axi inventory hosts <id|name>` to inspect one inventory's hosts",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveHost(input.args[0] ?? "");
  const detail = yield* read(`hosts/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `host ${id}` });
  }

  const groups = yield* readPaged(`hosts/${id}/groups/`, {}, null);
  const variables = yield* read(`hosts/${id}/variable_data/`);
  if (variables.status !== 200) {
    throw errorForResponse(variables, { subject: `host ${id} variables` });
  }

  const facts = yield* read(`hosts/${id}/ansible_facts/`);
  if (facts.status !== 200) {
    throw errorForResponse(facts, { subject: `host ${id} facts` });
  }

  const body = record(detail.body);
  const summary = record(body.summary_fields);
  const context = inventoryContext(body);
  const lastJob = record(summary.last_job);

  return detailOutput({
    label: "host",
    fields: {
      id,
      name: stringOrNull(body.name),
      description: stringOrNull(body.description),
      inventory: context.inventory,
      organization: context.organization,
      enabled: booleanOrFalse(body.enabled),
      instance_id: stringOrNull(body.instance_id),
      has_active_failures: booleanOrFalse(body.has_active_failures),
      has_inventory_sources: booleanOrFalse(body.has_inventory_sources),
      last_job: formatReference(
        numberOrNull(lastJob.id) ?? numberOrNull(body.last_job),
        stringOrNull(lastJob.name),
      ),
      last_job_host_summary: body.last_job_host_summary ?? null,
      ansible_facts_modified: stringOrNull(body.ansible_facts_modified),
      groups: groups.rows.map(toGroup).map((group) => redactValue(group)),
      variables: redactValue(variables.body),
      facts: redactValue(facts.body),
    },
    help: [
      `Run \`awx-axi host list --inventory ${typeof body.inventory === "number" ? body.inventory : "<id>"}\` to inspect sibling hosts`,
      `Run \`awx-axi job hosts <id>\` to inspect this host's job summaries`,
    ],
  });
}

function* inspectPlan(input: SubcommandInput): Plan<DomainResult> {
  const selectors = (input.args[0] ?? "").split(",").map((value) => value.trim());
  if (selectors.length > 10 || selectors.some((value) => value.length === 0)) {
    throw validationError("host inspect requires 1-10 nonempty comma-separated selectors", ["Run `awx-axi host inspect 501,601`"]);
  }
  if (selectors.some((value) => /^\d+$/.test(value) && (!Number.isSafeInteger(Number(value)) || Number(value) < 1))) {
    throw validationError("host IDs must be positive safe integers");
  }
  const inventory = typeof input.flags.inventory === "string" ? parseInventory(input.flags.inventory) : undefined;
  const budget: ReadBudget = { remaining: 100, deadline: Date.now() + 60_000 };
  const hosts: RecordValue[] = [];
  let stopped: string | undefined;
  let ambiguous = false;
  const rowLimit = Math.floor(17_000 / selectors.length);

  for (const selector of selectors) {
    let row: RecordValue = { selector, status: "complete", complete: true };
    let id: number | undefined;
    if (stopped !== undefined) {
      row.status = "skipped";
      row.complete = false;
      row.error = { code: stopped };
    } else {
      try {
        id = yield* resolveHost(selector, inventory, budget);
        const detail = yield* read(`hosts/${id}/`, {}, budget);
        if (detail.status !== 200) throw errorForResponse(detail, { subject: `host ${id}` });
        const body = record(detail.body);
        if (inventory !== undefined && body.inventory !== inventory) {
          throw new AxiError(`host ${id} does not belong to inventory ${inventory}`, "INVENTORY_MISMATCH");
        }
        const lastJob = record(record(body.summary_fields).last_job);
        row.host = {
          ...toHostRow(body), description: body.description ?? null,
          last_job: formatReference(numberOrNull(lastJob.id) ?? numberOrNull(body.last_job), stringOrNull(lastJob.name)),
          last_job_host_summary: body.last_job_host_summary ?? null,
          ansible_facts_modified: body.ansible_facts_modified ?? null,
        };
        const errors: RecordValue[] = [];
        for (const component of ["groups", "variables", "facts"] as const) {
          try {
            if (component === "groups") {
              const groups = yield* readPaged(`hosts/${id}/groups/`, {}, { all: true, maxRows: 1000 }, budget);
              row.groups = groups.rows.map(toGroup);
              row.groups_pagination = groups.pagination;
              if (groups.pagination.truncated) errors.push({ component, code: "INCOMPLETE_COLLECTION" });
            } else {
              const route = component === "variables" ? "variable_data" : "ansible_facts";
              const response = yield* read(`hosts/${id}/${route}/`, {}, budget);
              if (response.status !== 200) throw errorForResponse(response, { subject: `host ${id} ${component}` });
              row[component] = response.body;
            }
          } catch (error) {
            if (!(error instanceof AxiError)) throw error;
            errors.push({ component, code: error.code, error: error.message });
            if (error.code === "REQUEST_BUDGET" || error.code === "TIME_BUDGET") {
              stopped = error.code;
              row.skipped_components = component === "groups" ? ["variables", "facts"] : component === "variables" ? ["facts"] : [];
              break;
            }
          }
        }
        if (errors.length > 0) {
          row.errors = errors;
          row.status = "failed";
          row.complete = false;
        }
      } catch (error) {
        if (!(error instanceof AxiError)) throw error;
        if (error.code === "AMBIGUOUS_NAME") ambiguous = true;
        row.status = "failed";
        row.complete = false;
        row.error = { code: error.code, error: error.message, ...(error instanceof AwxAxiError ? error.details : {}) };
        if (error.code === "REQUEST_BUDGET" || error.code === "TIME_BUDGET") stopped = error.code;
      }
    }
    const help = `Run \`awx-axi host show ${id ?? "<id>"}\` for full details`;
    row.help = help;
    row = redactValue(row) as RecordValue;
    const selectorError = record(row.error);
    if (Array.isArray(selectorError.candidates) && encode({ hosts: [row] }).length > rowLimit) {
      const candidates = selectorError.candidates;
      selectorError.candidates = candidates.slice(0, 3).map((candidate) => {
        const match = record(candidate);
        const compact = (value: unknown) => typeof value === "string" && value.length > 80 ? `${value.slice(0, 80)}... [truncated]` : value;
        return { id: match.id, name: compact(match.name), inventory: compact(match.inventory) };
      });
      selectorError.candidates_truncated = true;
      selectorError.candidates_total = candidates.length;
      row.code = "OUTPUT_BUDGET";
    }
    const host = record(row.host);
    const fields: [RecordValue, string][] = [
      ...Object.keys(host).map((key): [RecordValue, string] => [host, key]),
      ...["variables", "facts", "groups", "selector"].map((key): [RecordValue, string] => [row, key]),
      [selectorError, "error"],
      ...(Array.isArray(row.errors) ? row.errors.map((error): [RecordValue, string] => [record(error), "error"]) : []),
    ];
    const values = fields.filter(([owner, key]) => owner[key] !== undefined)
      .map(([owner, key]) => ({ owner, key, text: encode({ [key]: owner[key] }) }))
      .sort((left, right) => right.text.length - left.text.length);
    for (const { owner, key, text } of values) {
      if (encode({ hosts: [row] }).length <= rowLimit) break;
      if (text.length <= 100) continue;
      const preview = { truncated: true, total_chars: text.length, preview: text.slice(0, Math.floor(rowLimit / 8)) };
      owner[key] = preview;
      if (row.status === "complete") row.status = "failed";
      row.complete = false;
      row.code = "OUTPUT_BUDGET";
      while (preview.preview.length > 0 && encode({ hosts: [row] }).length > rowLimit) {
        preview.preview = preview.preview.slice(0, Math.floor(preview.preview.length / 2));
      }
    }
    hosts.push(row);
  }
  const complete = hosts.every((host) => host.complete === true);
  return withExitCode({
    complete,
    budgets: { max_hosts: 10, max_requests: 100, requests: 100 - budget.remaining, max_seconds: 60, max_chars: 20_000 },
    hosts,
  }, ambiguous ? 2 : complete ? 0 : 1);
}

export const hostDomain: Domain = defineDomain({
  name: "host",
  help: [
    "host: inspect managed hosts across all visible inventories",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]",
    "  show  <id|name>",
    "  inspect <selectors> [--inventory <id>]",
  ].join("\n"),
  mcpEquivalents: ["list_inventory_hosts"],
  subcommands: [
    {
      name: "inspect",
      help: "awx-axi host inspect <selectors> [--inventory <id>]\nSelectors: 1-10 comma-separated IDs or names. Inventory scopes names and checks IDs.\nRead-only limits: 100 GET attempts including retries/pages, 60 seconds, 20000 rendered characters; groups up to 1000 rows/100 pages.\nEach host reports complete/failed/skipped; any ambiguous selector exits 2, other incomplete details exit 1. Oversized details become labeled previews; use host show for full detail.\nExamples: awx-axi host inspect 501,601; awx-axi host inspect web-01,web-02 --inventory 11",
      flags: [{ name: "inventory", description: "scope names and verify host inventory id", takesValue: true }],
      positionals: { names: ["<selectors>"], required: 1 },
      schema: { label: "hosts", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: inspectPlan,
    },
    {
      name: "list",
      help: "awx-axi host list [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]" + PAGINATION_HELP,
      flags: [
        { name: "search", description: "search hosts and related facts", takesValue: true },
        { name: "name", description: "filter by exact host name", takesValue: true },
        { name: "inventory", description: "filter by inventory id", takesValue: true },
        ...PAGINATION_FLAGS,
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        { outcome: "listed", suggestions: ["Run `awx-axi host show <id|name>` for host detail"] },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi host show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "host", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
