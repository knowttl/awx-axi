/**
 * The `group` domain: inspect groups and their direct inventory members.
 *
 * Group creation and topology mutations remain under `inventory`; this noun is
 * read-only.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
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
import { resolveId } from "../../core/resolve.js";
import type { Query } from "../../core/transport.js";

const DEFAULT_LIST_LIMIT = 100;
const RELATION_LIMIT = 200;

const LIST_SCHEMA = {
  label: "groups",
  defaultFields: ["id", "name", "inventory", "organization"],
  fieldAllowlist: [],
} as const;

type RecordValue = Record<string, unknown>;

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

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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
  const group = record(raw);
  const summary = record(group.summary_fields);
  const inventory = record(summary.inventory);
  const organization = record(summary.organization);
  const inventoryOrganization = record(inventory.organization);

  return {
    inventory: formatReference(
      numberOrNull(inventory.id) ?? numberOrNull(group.inventory),
      stringOrNull(inventory.name),
    ),
    organization: formatReference(
      numberOrNull(organization.id) ??
        numberOrNull(inventoryOrganization.id) ??
        numberOrNull(inventory.organization_id),
      stringOrNull(organization.name) ?? stringOrNull(inventoryOrganization.name),
    ),
  };
}

function positiveLimit(raw: string | true | undefined): number {
  if (raw === true) {
    throw validationError("--limit needs a value for `group list`", [
      "Run `awx-axi group list --limit 100`",
    ]);
  }
  if (raw === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`group list\`, got ${raw}`,
      ["Run `awx-axi group list --limit 100`"],
    );
  }
  return value;
}

function parseInventory(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--inventory must be a positive integer for \`group list\`, got ${raw}`,
      ["Run `awx-axi group list --inventory <id>`"],
    );
  }
  return value;
}

function toGroupRow(raw: unknown): Row {
  const group = record(raw);
  const context = inventoryContext(group);
  return {
    id: numberOrNull(group.id) ?? 0,
    name: stringOrNull(group.name),
    inventory: context.inventory,
    organization: context.organization,
  };
}

function toHostRow(raw: unknown): RecordValue {
  const host = record(raw);
  const summary = record(host.summary_fields);
  const inventory = record(summary.inventory);
  return {
    id: numberOrNull(host.id),
    name: stringOrNull(host.name),
    inventory: formatReference(
      numberOrNull(inventory.id) ?? numberOrNull(host.inventory),
      stringOrNull(inventory.name),
    ),
    enabled: booleanOrNull(host.enabled),
  };
}

function toChildRow(raw: unknown): RecordValue {
  const group = record(raw);
  const context = inventoryContext(group);
  return {
    id: numberOrNull(group.id),
    name: stringOrNull(group.name),
    inventory: context.inventory,
  };
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

  const paged = yield* readPaged(
    "groups/",
    query,
    positiveLimit(input.flags.limit),
  );
  const rows = paged.rows.map(toGroupRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 groups found",
    help: [
      "Run `awx-axi group show <id|name>` for group detail",
      "Run `awx-axi inventory list` to find an inventory context",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "groups/",
    noun: "group",
    listCommand: "group list",
    command: "group show",
  });

  const detail = yield* read(`groups/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `group ${id}` });
  }

  const hosts = yield* readPaged(
    `groups/${id}/hosts/`,
    {},
    RELATION_LIMIT,
  );
  const children = yield* readPaged(
    `groups/${id}/children/`,
    {},
    RELATION_LIMIT,
  );
  const variables = yield* read(`groups/${id}/variable_data/`);
  if (variables.status !== 200) {
    throw errorForResponse(variables, { subject: `group ${id} variables` });
  }

  const body = record(detail.body);
  const context = inventoryContext(body);
  const inventoryId = numberOrNull(body.inventory);

  return detailOutput({
    label: "group",
    fields: {
      id,
      name: stringOrNull(body.name),
      description: stringOrNull(body.description),
      inventory: context.inventory,
      organization: context.organization,
      total_hosts: hosts.count ?? hosts.rows.length,
      total_children: children.count ?? children.rows.length,
      hosts: hosts.rows.map(toHostRow).map((host) => redactValue(host)),
      children: children.rows
        .map(toChildRow)
        .map((child) => redactValue(child)),
      variables: redactValue(variables.body),
    },
    help: [
      inventoryId === null
        ? "Run `awx-axi group list` to inspect groups"
        : `Run \`awx-axi group list --inventory ${inventoryId}\` to inspect groups in this inventory`,
      inventoryId === null
        ? "Run `awx-axi inventory list` to find the inventory context"
        : `Run \`awx-axi inventory hosts ${inventoryId}\` to inspect all hosts in this inventory`,
    ],
  });
}

export const groupDomain: Domain = defineDomain({
  name: "group",
  help: [
    "group: inspect inventory groups and their direct hosts and child groups",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["awx_inventory_groups_list"],
  subcommands: [
    {
      name: "list",
      help: [
        "awx-axi group list [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]",
        "",
        "Lists visible groups. `--search` searches group names and descriptions;",
        "`--name` and `--inventory` use AWX's exact field filters.",
        "",
        "Examples:",
        "  awx-axi group list --search web",
        "  awx-axi group list --inventory 11 --limit 50",
      ].join("\n"),
      flags: [
        { name: "search", description: "search group names and descriptions", takesValue: true },
        { name: "name", description: "filter by exact group name", takesValue: true },
        { name: "inventory", description: "filter by inventory id", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi group show <id|name>` for group detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: [
        "awx-axi group show <id|name>",
        "",
        "Shows a group, its inventory and organization context, direct hosts,",
        "direct child groups, and parsed group variables.",
        "",
        "Examples:",
        "  awx-axi group show 31",
        "  awx-axi group show web",
      ].join("\n"),
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "group", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
