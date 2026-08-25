/**
 * The `host` domain: inspect managed hosts across visible inventories.
 *
 * Host creation and mutation remain under `inventory`; this noun is read-only.
 */
import { AxiError } from "axi-sdk-js";

import { AwxAxiError, errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
import { redactValue } from "../../core/redact.js";
import {
  defineDomain,
  read,
  readPaged,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";
import type { Query } from "../../core/transport.js";

const DEFAULT_LIST_LIMIT = 100;
const GROUP_LIMIT = 200;

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
    throw validationError(`--inventory must be a positive integer for \`host list\`, got ${raw}`, [
      "Run `awx-axi host list --inventory <id>`",
    ]);
  }
  return value;
}

function positiveLimit(
  raw: string | true | undefined,
): number {
  if (raw === true) {
    throw validationError("--limit needs a value for `host list`", [
      "Run `awx-axi host list --limit 100`",
    ]);
  }
  if (raw === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`host list\`, got ${raw}`,
      ["Run `awx-axi host list --limit 100`"],
    );
  }
  return value;
}

function* matchHostName(
  value: string,
  lookup: "name" | "name__iexact",
): Plan<NameMatches> {
  const response = yield* read("hosts/", { [lookup]: value });
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

function* resolveHost(value: string): Plan<number> {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  let page = yield* matchHostName(value, "name");
  if (page.matches.length === 0) {
    page = yield* matchHostName(value, "name__iexact");
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

  if (page.matches.length === 1) {
    return page.matches[0]!.id;
  }

  const total = page.count ?? page.matches.length;
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

  const limit = positiveLimit(input.flags.limit);
  const paged = yield* readPaged("hosts/", query, limit);
  const rows = paged.rows.map(toHostRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
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

  const groups = yield* readPaged(`hosts/${id}/groups/`, {}, GROUP_LIMIT);
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

export const hostDomain: Domain = defineDomain({
  name: "host",
  help: [
    "host: inspect managed hosts across all visible inventories",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_inventory_hosts"],
  subcommands: [
    {
      name: "list",
      help: "awx-axi host list [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]",
      flags: [
        { name: "search", description: "search hosts and related facts", takesValue: true },
        { name: "name", description: "filter by exact host name", takesValue: true },
        { name: "inventory", description: "filter by inventory id", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
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
