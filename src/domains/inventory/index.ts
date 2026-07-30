/**
 * The `inventory` domain: inspect inventories and constructed inventories, then
 * drill down into groups, hosts, sources, and update history.
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse, validationError } from "../../core/errors.js";
import {
  detailOutput,
  listOutput,
  type Row,
} from "../../core/output.js";
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
import { type PagedResult } from "../../core/transport.js";

const DEFAULT_LIST_LIMIT = 100;
const UPDATES_LIMIT = 25;

const INVENTORY_LIST_SCHEMA = {
  label: "inventories",
  defaultFields: ["id", "name", "organization", "kind", "type", "total_hosts"],
  fieldAllowlist: ["total_groups", "total_inventory_sources", "variables"],
} as const;

const GROUPS_SCHEMA = {
  label: "groups",
  defaultFields: ["id", "name", "inventory", "total_hosts"],
  fieldAllowlist: ["description", "variables", "total_children"],
} as const;

const HOSTS_SCHEMA = {
  label: "hosts",
  defaultFields: ["id", "name", "inventory", "enabled", "variables"],
  fieldAllowlist: ["facts", "description", "enabled_var"],
} as const;

const SOURCES_SCHEMA = {
  label: "inventory_sources",
  defaultFields: ["id", "name", "source", "status", "source_vars"],
  fieldAllowlist: ["source_project", "description", "update_on_launch"],
} as const;

const UPDATES_SCHEMA = {
  label: "inventory_updates",
  defaultFields: ["id", "name", "status", "source", "finished"],
  fieldAllowlist: ["created", "source"],
} as const;

const CONSTRUCTED_INVENTORY_LIST_SCHEMA = {
  label: "constructed_inventories",
  defaultFields: ["id", "name", "source", "verbosity", "limit"],
  fieldAllowlist: ["update_cache_timeout", "source_vars", "variables"],
} as const;

const UPDATE_STATUSES = [
  "canceled",
  "error",
  "failed",
  "pending",
  "running",
  "successful",
] as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`inventory ${subcommand}\`, got --limit`,
      [`Run \`awx-axi inventory ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`inventory ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi inventory ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function formatState(value: unknown): string {
  return typeof value === "string" ? "configured" : "not set";
}

function toString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function toBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function toInventoryRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const organization = (summary.organization ?? {}) as Record<string, unknown>;

  return {
    id: toNumber(record.id),
    name: toString(record.name),
    organization:
      typeof organization.name === "string" ? `${organization.id ?? ""} (${organization.name})` : null,
    kind: toString(record.kind),
    type: toString(record.type),
    total_hosts: toNumber(record.total_hosts),
    total_groups: toNumber(record.total_groups),
    total_inventory_sources: toNumber(record.total_inventory_sources),
    variables: formatState(record.variables),
  };
}

function toConstructedInventoryRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;

  return {
    id: toNumber(record.id),
    name: toString(record.name),
    source: toString(record.source),
    verbosity: toString(record.verbosity),
    limit: toNumber(record.limit),
    update_cache_timeout: toNumber(record.update_cache_timeout),
    source_vars: formatState(record.source_vars),
    variables: formatState(record.variables),
  };
}

function toGroupRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const inventory = (summary.inventory ?? {}) as Record<string, unknown>;

  return {
    id: toNumber(record.id),
    name: toString(record.name),
    inventory:
      typeof inventory.name === "string" ? `${inventory.id ?? ""} (${inventory.name})` : null,
    total_hosts: toNumber(record.total_hosts),
    description: toString(record.description),
    total_children: toNumber(record.total_children),
    variables: formatState(record.variables),
  };
}

function toHostRow(raw: unknown, includeFacts: boolean): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const inventory = (summary.inventory ?? {}) as Record<string, unknown>;

  return {
    id: toNumber(record.id),
    name: toString(record.name),
    inventory:
      typeof inventory.name === "string" ? `${inventory.id ?? ""} (${inventory.name})` : null,
    enabled: toBoolean(record.enabled),
    description: toString(record.description),
    variables: formatState(record.variables),
    facts: includeFacts ? "" : null,
  };
}

function isUnsupportedConstructedInventory(error: unknown): boolean {
  return (
    error instanceof AxiError &&
    error.code === "NOT_FOUND" &&
    error.message.includes("constructed_inventories")
  );
}

function addHostFacts(row: Row, factsBody: unknown): Row {
  if (typeof factsBody !== "object" || factsBody === null || Array.isArray(factsBody)) {
    return { ...row, facts: "not available" };
  }

  return {
    ...row,
    facts: `${Object.keys(factsBody).length} keys`,
  };
}

function toSourceRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const inventory = (summary.inventory ?? {}) as Record<string, unknown>;
  const sourceProject = (summary.source_project ?? {}) as Record<string, unknown>;

  return {
    id: toNumber(record.id),
    name: toString(record.name),
    inventory:
      typeof inventory.name === "string" ? `${inventory.id ?? ""} (${inventory.name})` : null,
    source: toString(record.source),
    status: toString(record.status),
    source_project:
      typeof sourceProject.name === "string"
        ? `${sourceProject.id ?? ""} (${sourceProject.name})`
        : null,
    source_vars: formatState(record.source_vars),
  };
}

function toUpdateRow(raw: unknown, sourceName: string, sourceId: number): Row {
  const record = (raw ?? {}) as Record<string, unknown>;

  return {
    id: toNumber(record.id),
    name: toString(record.name),
    source: `${sourceId} (${sourceName})`,
    status: toString(record.status),
    finished: toString(record.finished),
    created: toString(record.created),
  };
}

function assertValidStatus(raw: string | undefined): void {
  if (raw === undefined) {
    return;
  }
  if (!UPDATE_STATUSES.includes(raw as (typeof UPDATE_STATUSES)[number])) {
    throw validationError(`unknown --status "${raw}" for \`inventory updates\``, [
      `valid statuses for \`inventory updates\`: ${UPDATE_STATUSES.join(", ")}`,
    ]);
  }
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("inventories/", query, limit);
  const rows = paged.rows.map(toInventoryRow);

  return listOutput({
    label: INVENTORY_LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 inventories found",
    help: [
      "Run `awx-axi inventory show <id|name>` for inventory detail",
      "Run `awx-axi inventory groups <id|name>` for group drill-down",
      "Run `awx-axi inventory hosts <id|name>` for host members",
      "Run `awx-axi inventory sources <id|name>` for source definitions",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory show",
  });

  const detail = yield* read(`inventories/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `inventory ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const organization = (summary.organization ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "inventory",
    fields: {
      id,
      name: body.name ?? null,
      organization:
        typeof organization.name === "string"
          ? `${organization.id ?? ""} (${organization.name})`
          : null,
      type: body.type ?? null,
      kind: body.kind ?? null,
      variables: body.variables ?? null,
      has_active_failures: body.has_active_failures ?? null,
      has_inventory_sources: body.has_inventory_sources ?? null,
      total_hosts: body.total_hosts ?? null,
      total_groups: body.total_groups ?? null,
      total_inventory_sources: body.total_inventory_sources ?? null,
    },
    help: [
      `Run \`awx-axi inventory groups ${id}\` to inspect groups in this inventory`,
      `Run \`awx-axi inventory hosts ${id}\` to inspect hosts in this inventory`,
      `Run \`awx-axi inventory sources ${id}\` to inspect source definitions`,
      `Run \`awx-axi inventory updates ${id}\` to inspect sync history`,
    ],
  });
}

function* groupsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory groups",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "groups");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged(`inventories/${id}/groups/`, query, limit);
  const rows = paged.rows.map(toGroupRow);

  return listOutput({
    label: GROUPS_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 groups found",
    help: [
      `Run \`awx-axi inventory hosts ${id}\` to inspect host members`,
      `Run \`awx-axi inventory sources ${id}\` to inspect inventory sources`,
    ],
  });
}

function* hostsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory hosts",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "hosts");
  const query: Record<string, string | number | boolean> = {};
  const withFacts = input.flags.facts === true;

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged(`inventories/${id}/hosts/`, query, limit);
  const rows = paged.rows.map((row) => {
    const base = toHostRow(row, withFacts);
    return base;
  });

  if (!withFacts || rows.length === 0) {
    return listOutput({
      label: HOSTS_SCHEMA.label,
      rows,
      count: paged.count,
      empty: "0 hosts found",
      help: [
        `Run \`awx-axi inventory updates ${id}\` to inspect recent update runs`,
      ],
    });
  }

  const enriched: Row[] = [];
  for (const row of rows) {
    const hostId = row.id;
    const factRes = yield* read(`hosts/${hostId}/ansible_facts/`);
    if (factRes.status !== 200) {
      throw errorForResponse(factRes, {
        subject: `host ${hostId} facts`,
      });
    }
    enriched.push(addHostFacts(row, factRes.body));
  }

  return listOutput({
    label: HOSTS_SCHEMA.label,
    rows: enriched,
    count: paged.count,
    empty: "0 hosts found",
    help: [
      `Run \`awx-axi inventory updates ${id}\` to inspect recent update runs`,
    ],
  });
}

function* sourcesPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory sources",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "sources");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged(`inventories/${id}/inventory_sources/`, query, limit);
  const rows = paged.rows.map(toSourceRow);

  return listOutput({
    label: SOURCES_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 inventory sources found",
    help: [
      `Run \`awx-axi inventory updates ${id}\` for this inventory's source sync runs`,
    ],
  });
}

function* updatesPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory updates",
  });

  const limit = positiveLimit(input.flags.limit, UPDATES_LIMIT, "updates");
  const search = typeof input.flags.search === "string" ? input.flags.search : undefined;
  const status = typeof input.flags.status === "string" ? input.flags.status : undefined;

  assertValidStatus(status);

  const sourceQuery: Record<string, string | number | boolean> = {};
  const sourcePages = yield* readPaged(`inventories/${id}/inventory_sources/`, sourceQuery, DEFAULT_LIST_LIMIT);

  if (sourcePages.rows.length === 0) {
    return listOutput({
      label: UPDATES_SCHEMA.label,
      rows: [],
      count: 0,
      empty: "0 inventory sources found, and therefore 0 inventory updates",
      help: [
        `Run \`awx-axi inventory sources ${id}\` to confirm what this inventory is sourced from`,
      ],
    });
  }

  const updatesQuery: Record<string, string | number | boolean> = {};
  if (search !== undefined) {
    updatesQuery.search = search;
  }
  if (status !== undefined) {
    updatesQuery.status = status;
  }

  const updates: Row[] = [];
  for (const source of sourcePages.rows) {
    if (updates.length >= limit) {
      break;
    }
    const sourceRecord = (source ?? {}) as Record<string, unknown>;
    const sourceId = toNumber(sourceRecord.id);
    if (sourceId === 0) {
      continue;
    }
    const sourceName =
      typeof sourceRecord.name === "string" ? sourceRecord.name : String(sourceId);
    const remaining = Math.max(1, limit - updates.length);

    const sourceUpdates = yield* readPaged(
      `inventory_sources/${sourceId}/inventory_updates/`,
      updatesQuery,
      remaining,
    );

    const filtered = sourceUpdates.rows
      .map((row) => toUpdateRow(row, sourceName, sourceId))
      .filter((row) => status === undefined || row.status === status);

    updates.push(...filtered);
  }

  return listOutput({
    label: UPDATES_SCHEMA.label,
    rows: updates,
    count: updates.length,
    empty:
      status === undefined
        ? "0 inventory updates found"
        : `0 inventory updates found with status ${status}`,
    help: [
      "Run `awx-axi job list --type inventory-update` to inspect update outputs",
      `Run \`awx-axi inventory updates ${id} --limit ${limit * 2}\` for a longer history`,
    ],
  });
}

function* constructedListPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(
    input.flags.limit,
    DEFAULT_LIST_LIMIT,
    "constructed-list",
  );
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  let paged: PagedResult;
  try {
    paged = yield* readPaged("constructed_inventories/", query, limit);
  } catch (error) {
    if (isUnsupportedConstructedInventory(error)) {
      return listOutput({
        label: CONSTRUCTED_INVENTORY_LIST_SCHEMA.label,
        rows: [],
        count: 0,
        empty: "0 constructed inventories found",
        help: [
          "This controller does not expose constructed inventories",
          "Run `awx-axi inventory list` to inspect standard inventories",
        ],
      });
    }
    throw error;
  }

  const rows = paged.rows.map(toConstructedInventoryRow);

  return listOutput({
    label: CONSTRUCTED_INVENTORY_LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 constructed inventories found",
    help: [
      "Run `awx-axi inventory constructed-show <id|name>` to inspect one constructed inventory",
      "Controllers without constructed inventories return 404 from this command",
    ],
  });
}

function* constructedShowPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "constructed_inventories/",
    noun: "constructed inventory",
    listCommand: "inventory constructed-list",
    command: "inventory constructed-show",
  });

  const detail = yield* read(`constructed_inventories/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `constructed inventory ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const organization = (summary.organization ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "inventory",
    fields: {
      id,
      name: body.name ?? null,
      organization:
        typeof organization.name === "string"
          ? `${organization.id ?? ""} (${organization.name})`
          : null,
      source: body.source ?? null,
      source_vars: body.source_vars ?? null,
      verbosity: body.verbosity ?? null,
      variables: body.variables ?? null,
      update_cache_timeout: body.update_cache_timeout ?? null,
      limit: body.limit ?? null,
    },
    help: [
      "Run `awx-axi inventory constructed-list` to inspect all constructed inventories",
      `Run \`awx-axi inventory updates ${id}\` to inspect source sync attempts from this base inventory`,
    ],
  });
}

export const inventoryDomain: Domain = defineDomain({
  name: "inventory",
  help: [
    "inventory: inspect inventories and constructed inventories",
    "",
    "Subcommands:",
    "  list                 [--search <s>] [--limit <n>]",
    "  show                 <id|name>",
    "  groups               <id|name> [--search <s>] [--limit <n>]",
    "  hosts                <id|name> [--search <s>] [--limit <n>] [--facts]",
    "  sources              <id|name> [--search <s>] [--limit <n>]",
    "  updates              <id|name> [--search <s>] [--limit <n>] [--status <s>]",
    "  constructed-list     [--search <s>] [--limit <n>]",
    "  constructed-show     <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_inventories",
    "get_inventory",
    "list_inventory_groups",
    "list_inventory_hosts",
    "list_inventory_sources",
    "list_inventory_updates",
    "list_constructed_inventories",
    "get_constructed_inventory",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi inventory list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search inventories", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: INVENTORY_LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi inventory show <id|name>` for detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi inventory show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "inventory", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "groups",
      help: "awx-axi inventory groups <id|name> [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search groups", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: GROUPS_SCHEMA,
      suggestions: [],
      plan: groupsPlan,
    },
    {
      name: "hosts",
      help: "awx-axi inventory hosts <id|name> [--search <s>] [--limit <n>] [--facts]",
      flags: [
        { name: "search", description: "search hosts", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "facts", description: "include ansible fact key counts", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: HOSTS_SCHEMA,
      suggestions: [],
      plan: hostsPlan,
    },
    {
      name: "sources",
      help: "awx-axi inventory sources <id|name> [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search sources", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: SOURCES_SCHEMA,
      suggestions: [],
      plan: sourcesPlan,
    },
    {
      name: "updates",
      help: "awx-axi inventory updates <id|name> [--search <s>] [--limit <n>] [--status <s>]",
      flags: [
        { name: "search", description: "search updates", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        {
          name: "status",
          description: "filter updates by status",
          takesValue: true,
        },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: UPDATES_SCHEMA,
      suggestions: [],
      plan: updatesPlan,
    },
    {
      name: "constructed-list",
      help: "awx-axi inventory constructed-list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search constructed inventories", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: CONSTRUCTED_INVENTORY_LIST_SCHEMA,
      suggestions: [],
      plan: constructedListPlan,
    },
    {
      name: "constructed-show",
      help: "awx-axi inventory constructed-show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "inventory", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: constructedShowPlan,
    },
  ],
});
