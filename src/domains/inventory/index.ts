/**
 * The `inventory` domain: manage and inspect inventories, constructed inventories,
 * hosts, groups, sources, and update history.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive, parseJsonObject } from "../../core/mutations.js";
import { readFileSync } from "node:fs";
import {
  detailOutput,
  listOutput,
  type Row,
} from "../../core/output.js";
import { pollUntilTerminal, succeeded } from "../../core/poll.js";
import {
  defineDomain,
  read,
  readPaged,
  withExitCode,
  write,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";
import { resolveId } from "../../core/resolve.js";
import { type PagedResult, type Query } from "../../core/transport.js";

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

type ListPage = {
  readonly rows: readonly unknown[];
  readonly next: string | undefined;
};

function readListPage(body: unknown, subject: string): ListPage {
  if (body === null || typeof body !== "object") {
    throw new Error(`the controller returned a list page with no envelope for ${subject}`);
  }

  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new Error(`the controller returned a list page with no results for ${subject}`);
  }

  return {
    rows: record.results,
    next: typeof record.next === "string" ? record.next : undefined,
  };
}

type NextPage = {
  readonly route: string;
  readonly query: Query;
};

function parseNextQuery(next: string): NextPage {
  const divider = next.indexOf("?");
  if (divider < 0) {
    return { route: next.startsWith("/") ? next.replace(/^\//, "") : next, query: {} };
  }

  const dividerPath = next.indexOf("/api/v2/");
  const route = dividerPath < 0 ? next.slice(0, divider) : next.slice(dividerPath + 7, divider);
  const query: Query = {};
  const params = new URLSearchParams(next.slice(divider + 1));
  for (const [key, value] of params) {
    query[key] = value;
  }
  return {
    route: route.replace(/^\//, ""),
    query,
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

  const updates: Row[] = [];

  const updatesQuery: Record<string, string | number | boolean> = {};
  if (search !== undefined) {
    updatesQuery.search = search;
  }
  if (status !== undefined) {
    updatesQuery.status = status;
  }

  let sourceQuery: Query = {
    page_size: DEFAULT_LIST_LIMIT,
  };
  let sourceRoute = `inventories/${id}/inventory_sources/`;
  let sourceCount = 0;

  while (sourceRoute !== undefined && updates.length < limit) {
    const sourceListRes = yield* read(sourceRoute, sourceQuery);
    if (sourceListRes.status !== 200) {
      throw errorForResponse(sourceListRes, {
        subject: `inventory ${id} sources`,
      });
    }

    const sourcePage = readListPage(sourceListRes.body, `inventory ${id} sources`);
    sourceCount += sourcePage.rows.length;

    for (const source of sourcePage.rows) {
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

    if (sourcePage.next === undefined) {
      break;
    }

    sourceRoute = `inventories/${id}/inventory_sources/`;
    sourceQuery = parseNextQuery(sourcePage.next).query;
  }

  if (sourceCount === 0) {
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

  let rows: unknown[] = [];
  let count: number | undefined = undefined;
  let listRoute = "constructed_inventories/";
  let listQuery: Query = { ...query, page_size: limit };

  while (listRoute !== undefined && rows.length < limit) {
    const listResponse = yield* read(listRoute, listQuery);
    if (listResponse.status === 404) {
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
    if (listResponse.status !== 200) {
      throw errorForResponse(listResponse, { subject: "constructed inventories" });
    }

    const page = readListPage(listResponse.body, "constructed inventories");
    const listBody = (listResponse.body ?? {}) as Record<string, unknown>;
    count ??= typeof listBody.count === "number" ? listBody.count : undefined;
    rows = rows.concat(page.rows);
    if (page.next === undefined || page.rows.length === 0) {
      break;
    }
    const parsed = parseNextQuery(page.next);
    listRoute = parsed.route;
    listQuery = parsed.query;
  }

  const paged: PagedResult = {
    rows: rows.slice(0, limit),
    count,
  };

  const constructedRows = paged.rows.map(toConstructedInventoryRow);

  return listOutput({
    label: CONSTRUCTED_INVENTORY_LIST_SCHEMA.label,
    rows: constructedRows,
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

function* syncPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventory_sources/",
    noun: "inventory source",
    listCommand: "inventory sources",
    command: "inventory sync",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "sync",
        inventory_source: id,
        would_send: `POST inventory_sources/${id}/update/`,
      },
      help: ["Re-run with --confirm to sync"],
    });
  }

  const syncRes = yield* write(`inventory_sources/${id}/update/`, undefined, { method: "POST", tag: "operational" });
  if (syncRes.status !== 202 && syncRes.status !== 200 && syncRes.status !== 201) {
    throw errorForResponse(syncRes, { subject: `inventory source ${id}` });
  }

  const resBody = (syncRes.body ?? {}) as Record<string, unknown>;
  const updateId = typeof resBody.id === "number" ? resBody.id : id;

  if (input.flags.wait === true && typeof resBody.id === "number") {
    const timeoutSec = typeof input.flags.timeout === "string" ? Number(input.flags.timeout) : 3600;
    const pollRes = yield* pollUntilTerminal({
      route: `inventory_updates/${updateId}/`,
      timeoutMs: timeoutSec * 1000,
      resumeCommand: `awx-axi job watch ${updateId}`,
    });
    return withExitCode(
      detailOutput({
        label: "inventory_update",
        fields: {
          id: updateId,
          inventory_source: id,
          status: pollRes.status,
          waited: `${Math.round(pollRes.waitedMs / 1000)}s`,
        },
        help: [`Run \`awx-axi job show ${updateId}\` for job detail`],
      }),
      succeeded(pollRes.status) ? 0 : 1,
    );
  }

  return detailOutput({
    label: "inventory_update",
    fields: {
      id: updateId,
      inventory_source: id,
      status: resBody.status ?? "pending",
    },
    help: [`Run \`awx-axi job watch ${updateId}\` to monitor sync`],
  });
}

function* createInventoryPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name === "") {
    throw validationError("`inventory create` needs a name argument or --name", [
      "Provide a name, e.g. `awx-axi inventory create Production`",
    ]);
  }

  const requestedKind = typeof input.flags.kind === "string" ? input.flags.kind : "standard";
  if (requestedKind !== "standard" && requestedKind !== "smart") {
    throw validationError("--kind must be standard or smart for `inventory create`", [
      "Run `awx-axi inventory create <name> --kind smart --organization <id|name> --host-filter <filter>`",
    ]);
  }

  const hostFilter = typeof input.flags["host-filter"] === "string"
    ? input.flags["host-filter"]
    : undefined;
  const resolvedKind = requestedKind === "smart" || hostFilter !== undefined ? "smart" : "standard";
  const organization = typeof input.flags.organization === "string"
    ? input.flags.organization
    : undefined;

  if (resolvedKind === "smart" && (organization === undefined || organization === "")) {
    throw validationError("`inventory create` needs --organization id or name for a smart inventory");
  }
  if (resolvedKind === "smart" && (hostFilter === undefined || hostFilter === "")) {
    throw validationError("`inventory create` needs a non-empty --host-filter for a smart inventory");
  }

  let orgId: number | undefined;
  if (organization !== undefined) {
    orgId = yield* resolveId(organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "inventory create",
    });
  }

  const payload: Record<string, unknown> = { name };
  if (orgId !== undefined) payload.organization = orgId;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.variables === "string") payload.variables = input.flags.variables;
  if (resolvedKind === "smart") {
    payload.kind = "smart";
    payload.host_filter = hostFilter;
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "inventory",
        name,
        kind: resolvedKind,
        host_filter: hostFilter ?? null,
        would_send: "POST inventories/",
        payload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("inventories/", payload, { method: "POST", tag: "config" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `inventory ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "inventory",
    fields: {
      id,
      name: body.name ?? name,
      organization: orgId ?? null,
      kind: resolvedKind,
      host_filter: hostFilter ?? null,
    },
    help: [`Run \`awx-axi inventory show ${id}\` to inspect inventory`],
  });
}

function* editInventoryPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.organization === "string") {
    payload.organization = yield* resolveId(input.flags.organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "inventory edit",
    });
  }
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.variables === "string") payload.variables = input.flags.variables;
  if (typeof input.flags["host-filter"] === "string") payload.host_filter = input.flags["host-filter"];

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        inventory: id,
        would_send: `PATCH inventories/${id}/`,
        payload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`inventories/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `inventory ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "inventory",
    fields: {
      id,
      name: body.name ?? null,
    },
    help: [`Run \`awx-axi inventory show ${id}\` to inspect updated inventory`],
  });
}

function* createHostPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name === "") {
    throw validationError("`inventory host-create` needs a host name argument or --name", [
      "Provide a name, e.g. `awx-axi inventory host-create web-01 --inventory Production`",
    ]);
  }

  const invArg = typeof input.flags.inventory === "string" ? input.flags.inventory : undefined;
  if (invArg === undefined || invArg === "") {
    throw validationError("`inventory host-create` needs an --inventory id or name", [
      "Run `awx-axi inventory list` to find an inventory",
    ]);
  }

  const inventoryId = yield* resolveId(invArg, {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory host-create",
  });

  const payload: Record<string, unknown> = {
    name,
    inventory: inventoryId,
  };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.variables === "string") payload.variables = input.flags.variables;
  if (input.flags.enabled === true) payload.enabled = true;
  if (input.flags.disabled === true) payload.enabled = false;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "host",
        name,
        inventory: inventoryId,
        would_send: "POST hosts/",
        payload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("hosts/", payload, { method: "POST", tag: "config" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `host ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "host",
    fields: {
      id,
      name: body.name ?? name,
      inventory: inventoryId,
      enabled: body.enabled ?? true,
    },
    help: [`Run \`awx-axi inventory hosts ${inventoryId}\` to list hosts`],
  });
}

function* editHostPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "hosts/",
    noun: "host",
    listCommand: "inventory hosts",
    command: "inventory host-edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.inventory === "string") {
    payload.inventory = yield* resolveId(input.flags.inventory, {
      listRoute: "inventories/",
      noun: "inventory",
      listCommand: "inventory list",
      command: "inventory host-edit",
    });
  }
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.variables === "string") payload.variables = input.flags.variables;
  if (input.flags.enabled === true) payload.enabled = true;
  if (input.flags.disabled === true) payload.enabled = false;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        host: id,
        would_send: `PATCH hosts/${id}/`,
        payload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`hosts/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `host ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "host",
    fields: {
      id,
      name: body.name ?? null,
      enabled: body.enabled ?? null,
    },
    help: [`Run \`awx-axi inventory hosts ${body.inventory ?? id}\` to list hosts`],
  });
}

function* deleteInventoryPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "inventory delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        inventory: id,
        would_send: `DELETE inventories/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`inventories/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `inventory ${id}` });
  }

  return detailOutput({
    label: "inventory",
    fields: {
      id,
      status: "deleted",
    },
  });
}

function* createGroupPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name.length === 0) throw validationError("`inventory group-create` needs a group name argument or --name");
  if (typeof input.flags.inventory !== "string") throw validationError("`inventory group-create` needs --inventory id or name");
  const inventory = yield* resolveId(input.flags.inventory, { listRoute: "inventories/", noun: "inventory", listCommand: "inventory list", command: "inventory group-create" });
  const payload: Record<string, unknown> = { name };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.variables === "string") payload.variables = input.flags.variables;
  if (!isLive(input.flags)) return dryRun("create", "group", { name, inventory }, `POST inventories/${inventory}/groups/`, payload);
  const response = yield* write(`inventories/${inventory}/groups/`, payload, { method: "POST", tag: "config" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `group ${name}` });
  const body = (response.body ?? {}) as Record<string, unknown>; const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "group", fields: { id, name: body.name ?? name, inventory }, help: [`Run \`awx-axi inventory groups ${inventory}\` to inspect groups`] });
}

function* editGroupPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "groups/", noun: "group", listCommand: "inventory groups", command: "inventory group-edit" });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.variables === "string") payload.variables = input.flags.variables;
  if (!isLive(input.flags)) return dryRun("edit", "group", { group: id }, `PATCH groups/${id}/`, payload);
  const response = yield* write(`groups/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (response.status !== 200) throw errorForResponse(response, { subject: `group ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return detailOutput({ label: "group", fields: { id, name: body.name ?? null }, help: [`Run \`awx-axi inventory groups <inventory>\` to inspect groups`] });
}

function* deleteGroupPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "groups/", noun: "group", listCommand: "inventory groups", command: "inventory group-delete" });
  if (!isLive(input.flags)) return dryRun("delete", "group", { group: id }, `DELETE groups/${id}/`);
  const response = yield* write(`groups/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (response.status !== 204 && response.status !== 200 && response.status !== 202) throw errorForResponse(response, { subject: `group ${id}` });
  return detailOutput({ label: "group", fields: { id, status: "deleted" } });
}

function associationPlan(kind: "host" | "child", remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const group = yield* resolveId(input.args[0] ?? "", { listRoute: "groups/", noun: "group", listCommand: "inventory groups", command: `inventory group-${remove ? "remove" : "add"}-${kind}` });
    const flag = kind === "host" ? "host" : "child";
    const listRoute = kind === "host" ? "hosts/" : "groups/";
    const noun = kind === "host" ? "host" : "group";
    const raw = input.flags[flag];
    if (typeof raw !== "string") throw validationError(`inventory group-${remove ? "remove" : "add"}-${kind} needs --${flag}`);
    const target = yield* resolveId(raw, { listRoute, noun, listCommand: kind === "host" ? "inventory hosts" : "inventory groups", command: `inventory group-${remove ? "remove" : "add"}-${kind}` });
    const path = `groups/${group}/${kind === "host" ? "hosts" : "children"}/`;
    const payload = remove ? { id: target, disassociate: true } : { id: target };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", noun, { group, [flag]: target }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `group ${group}` });
    return detailOutput({ label: "group_association", fields: { group, [flag]: target, status: remove ? "removed" : "added" } });
  };
}

function* createSourcePlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name.length === 0) throw validationError("`inventory source-create` needs a source name argument or --name");
  if (typeof input.flags.inventory !== "string") throw validationError("`inventory source-create` needs --inventory id or name");
  if (typeof input.flags.source !== "string") throw validationError("`inventory source-create` needs --source");
  const payload: Record<string, unknown> = { name, source: input.flags.source, inventory: yield* resolveId(input.flags.inventory, { listRoute: "inventories/", noun: "inventory", listCommand: "inventory list", command: "inventory source-create" }) };
  if (typeof input.flags["source-project"] === "string") payload.source_project = yield* resolveId(input.flags["source-project"], { listRoute: "projects/", noun: "project", listCommand: "project list", command: "inventory source-create" });
  if (typeof input.flags.credential === "string") payload.credential = yield* resolveId(input.flags.credential, { listRoute: "credentials/", noun: "credential", listCommand: "credential list", command: "inventory source-create" });
  if (typeof input.flags["source-vars"] === "string") {
    parseJsonObject(input.flags["source-vars"], "--source-vars");
    payload.source_vars = input.flags["source-vars"];
  }
  if (input.flags["update-on-launch"] === true) payload.update_on_launch = true;
  if (!isLive(input.flags)) return dryRun("create", "inventory_source", { name }, "POST inventory_sources/", payload);
  const response = yield* write("inventory_sources/", payload, { method: "POST", tag: payload.credential === undefined ? "config" : "security" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `inventory source ${name}` });
  const body = (response.body ?? {}) as Record<string, unknown>; const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "inventory_source", fields: { id, name: body.name ?? name }, help: [`Run \`awx-axi inventory sources <inventory>\` to inspect source`] });
}

function* editSourcePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "inventory_sources/", noun: "inventory source", listCommand: "inventory sources", command: "inventory source-edit" });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.source === "string") payload.source = input.flags.source;
  if (typeof input.flags["source-project"] === "string") payload.source_project = yield* resolveId(input.flags["source-project"], { listRoute: "projects/", noun: "project", listCommand: "project list", command: "inventory source-edit" });
  if (typeof input.flags.credential === "string") payload.credential = yield* resolveId(input.flags.credential, { listRoute: "credentials/", noun: "credential", listCommand: "credential list", command: "inventory source-edit" });
  if (typeof input.flags["source-vars"] === "string") {
    parseJsonObject(input.flags["source-vars"], "--source-vars");
    payload.source_vars = input.flags["source-vars"];
  }
  if (input.flags["update-on-launch"] === true) payload.update_on_launch = true;
  if (input.flags["no-update-on-launch"] === true) payload.update_on_launch = false;
  if (!isLive(input.flags)) return dryRun("edit", "inventory_source", { inventory_source: id }, `PATCH inventory_sources/${id}/`, payload);
  const response = yield* write(`inventory_sources/${id}/`, payload, { method: "PATCH", tag: payload.credential === undefined ? "config" : "security" });
  if (response.status !== 200) throw errorForResponse(response, { subject: `inventory source ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return detailOutput({ label: "inventory_source", fields: { id, name: body.name ?? null }, help: [`Run \`awx-axi inventory sources <inventory>\` to inspect source`] });
}

function* deleteSourcePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "inventory_sources/", noun: "inventory source", listCommand: "inventory sources", command: "inventory source-delete" });
  if (!isLive(input.flags)) return dryRun("delete", "inventory_source", { inventory_source: id }, `DELETE inventory_sources/${id}/`);
  const response = yield* write(`inventory_sources/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (response.status !== 204 && response.status !== 200 && response.status !== 202) throw errorForResponse(response, { subject: `inventory source ${id}` });
  return detailOutput({ label: "inventory_source", fields: { id, status: "deleted" } });
}

function sourceCredentialPlan(remove: boolean): (input: SubcommandInput) => Plan<DomainResult> {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const source = yield* resolveId(input.args[0] ?? "", { listRoute: "inventory_sources/", noun: "inventory source", listCommand: "inventory sources", command: `inventory source-credential-${remove ? "remove" : "add"}` });
    if (typeof input.flags.credential !== "string") throw validationError("inventory source credential association needs --credential");
    const credential = yield* resolveId(input.flags.credential, { listRoute: "credentials/", noun: "credential", listCommand: "credential list", command: "inventory source-credential" });
    const path = `inventory_sources/${source}/credentials/`; const payload = remove ? { id: credential, disassociate: true } : { id: credential };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", "credential", { inventory_source: source, credential }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: "security" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `inventory source ${source}` });
    return detailOutput({ label: "inventory_source_credential", fields: { inventory_source: source, credential, status: remove ? "removed" : "added" } });
  };
}

function sourceNotificationPlan(remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const source = yield* resolveId(input.args[0] ?? "", { listRoute: "inventory_sources/", noun: "inventory source", listCommand: "inventory sources", command: `inventory source-notification-${remove ? "remove" : "add"}` });
    const event = input.flags.event; if (typeof event !== "string" || !["started", "success", "error"].includes(event)) throw validationError("--event must be started, success, or error");
    if (typeof input.flags["notification-template"] !== "string") throw validationError("source notification association needs --notification-template");
    const template = yield* resolveId(input.flags["notification-template"], { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "inventory source notification" });
    const path = `inventory_sources/${source}/notification_templates_${event}/`; const payload = remove ? { id: template, disassociate: true } : { id: template };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", "notification_template", { inventory_source: source, notification_template: template, event }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `inventory source ${source} notifications` });
    return detailOutput({ label: "inventory_source_notification", fields: { inventory_source: source, notification_template: template, event, status: remove ? "removed" : "added" } });
  };
}

function readHostsFile(path: string): unknown[] {
  try { const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); if (Array.isArray(parsed)) return parsed; } catch { /* translated below */ }
  throw validationError("--hosts-file must contain a JSON array of host objects or ids");
}

function* bulkHostCreatePlan(input: SubcommandInput): Plan<DomainResult> {
  if (typeof input.flags.inventory !== "string" || typeof input.flags["hosts-file"] !== "string") throw validationError("`inventory host-bulk-create` needs --inventory and --hosts-file");
  const inventory = yield* resolveId(input.flags.inventory, { listRoute: "inventories/", noun: "inventory", listCommand: "inventory list", command: "inventory host-bulk-create" });
  const hosts = readHostsFile(input.flags["hosts-file"]);
  const payload = { inventory, hosts };
  if (!isLive(input.flags)) return dryRun("create", "hosts", { inventory, count: hosts.length }, "POST bulk/host_create/", payload);
  const response = yield* write("bulk/host_create/", payload, { method: "POST", tag: "config" });
  if (response.status !== 200 && response.status !== 201) throw errorForResponse(response, { subject: `bulk hosts in inventory ${inventory}` });
  return detailOutput({ label: "hosts", fields: { inventory, count: hosts.length, status: "created" } });
}

function* bulkHostDeletePlan(input: SubcommandInput): Plan<DomainResult> {
  if (typeof input.flags["hosts-file"] !== "string") throw validationError("`inventory host-bulk-delete` needs --hosts-file");
  const hosts = readHostsFile(input.flags["hosts-file"]);
  const ids = hosts.map((host) => typeof host === "number" ? host : Number(host));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) throw validationError("bulk host delete file must contain numeric host ids");
  const payload = { hosts: ids };
  if (!isLive(input.flags)) return dryRun("delete", "hosts", { count: ids.length }, "POST bulk/host_delete/", payload);
  const response = yield* write("bulk/host_delete/", payload, { method: "POST", tag: "delete" });
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: "bulk hosts" });
  return detailOutput({ label: "hosts", fields: { count: ids.length, status: "deleted" } });
}

function* deleteHostPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "hosts/",
    noun: "host",
    listCommand: "inventory hosts",
    command: "inventory host-delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        host: id,
        would_send: `DELETE hosts/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`hosts/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `host ${id}` });
  }

  return detailOutput({
    label: "host",
    fields: {
      id,
      status: "deleted",
    },
  });
}

const baseInventoryDomain: Domain = defineDomain({
  name: "inventory",
  help: [
    "inventory: inspect inventories, sources, hosts, and update history",
    "",
    "Subcommands:",
    "  create               [<name>] [--organization <o>] [--kind <standard|smart>] [--host-filter <filter>] [--confirm] [--dry-run]",
    "  edit                 <id|name> [--name <n>] [--host-filter <filter>] [--confirm] [--dry-run]",
    "  delete               <id|name> [--confirm] [--dry-run]",
    "  sync                 <id|name> [--wait] [--confirm] [--dry-run]",
    "  host-create          [<name>] --inventory <i|name> [--confirm] [--dry-run]",
    "  host-edit            <id|name> [--confirm] [--dry-run]",
    "  host-delete          <id|name> [--confirm] [--dry-run]",
    "  host-bulk-create     --inventory <i|name> --hosts-file <path> [--confirm] [--dry-run]",
    "  host-bulk-delete     --hosts-file <path> [--confirm] [--dry-run]",
    "  group-create|group-edit|group-delete",
    "  group-add-host|group-remove-host|group-add-child|group-remove-child",
    "  source-create|source-edit|source-delete|source-credential-add|source-credential-remove",
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
    "create_inventory",
    "update_inventory",
    "delete_inventory",
    "sync_inventory_source",
    "create_host",
    "update_host",
    "delete_host",
    "list_inventory_groups",
    "list_inventory_hosts",
    "list_inventory_sources",
    "list_inventory_updates",
    "list_constructed_inventories",
    "get_constructed_inventory",
  ],
  subcommands: [
    {
      name: "host-bulk-create", help: "awx-axi inventory host-bulk-create --inventory <i|name> --hosts-file <path> [--confirm] [--dry-run]",
      flags: [{ name: "inventory", description: "inventory id or name", takesValue: true }, { name: "hosts-file", description: "JSON host array file", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: [], required: 0 }, schema: { label: "hosts", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: bulkHostCreatePlan,
    },
    {
      name: "host-bulk-delete", help: "awx-axi inventory host-bulk-delete --hosts-file <path> [--confirm] [--dry-run]",
      flags: [{ name: "hosts-file", description: "JSON host id array file", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: [], required: 0 }, schema: { label: "hosts", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: bulkHostDeletePlan,
    },
    {
      name: "group-create", help: "awx-axi inventory group-create [<name>] --inventory <i|name> [--confirm] [--dry-run]",
      flags: [{ name: "name", description: "group name", takesValue: true }, { name: "inventory", description: "inventory id or name", takesValue: true }, { name: "description", description: "description", takesValue: true }, { name: "variables", description: "group variables", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<name>"], required: 0 }, schema: { label: "group", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: createGroupPlan,
    },
    {
      name: "group-edit", help: "awx-axi inventory group-edit <id|name> [--confirm] [--dry-run]",
      flags: [{ name: "name", description: "group name", takesValue: true }, { name: "description", description: "description", takesValue: true }, { name: "variables", description: "group variables", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "group", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: editGroupPlan,
    },
    {
      name: "group-delete", help: "awx-axi inventory group-delete <id|name> [--confirm] [--dry-run]",
      flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "group", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: deleteGroupPlan,
    },
    ...(["group-add-host", "group-remove-host", "group-add-child", "group-remove-child"] as const).map((name) => {
      const child = name.endsWith("child"); const remove = name.includes("remove");
      return { name, help: `awx-axi inventory ${name} <group> --${child ? "child" : "host"} <id|name> [--confirm] [--dry-run]`, flags: [{ name: child ? "child" : "host", description: child ? "child group id or name" : "host id or name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "group_association", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: associationPlan(child ? "child" : "host", remove) };
    }),
    {
      name: "source-create", help: "awx-axi inventory source-create [<name>] --inventory <i|name> --source <type> [--confirm] [--dry-run]",
      flags: [{ name: "name", description: "source name", takesValue: true }, { name: "inventory", description: "inventory id or name", takesValue: true }, { name: "source", description: "source type", takesValue: true }, { name: "source-project", description: "source project id or name", takesValue: true }, { name: "credential", description: "credential id or name", takesValue: true }, { name: "source-vars", description: "source variables JSON", takesValue: true }, { name: "update-on-launch", description: "update on launch", takesValue: false }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<name>"], required: 0 }, schema: { label: "inventory_source", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: createSourcePlan,
    },
    {
      name: "source-edit", help: "awx-axi inventory source-edit <id|name> [--confirm] [--dry-run]",
      flags: [{ name: "name", description: "source name", takesValue: true }, { name: "source", description: "source type", takesValue: true }, { name: "source-project", description: "source project id or name", takesValue: true }, { name: "credential", description: "credential id or name", takesValue: true }, { name: "source-vars", description: "source variables JSON", takesValue: true }, { name: "update-on-launch", description: "update on launch", takesValue: false }, { name: "no-update-on-launch", description: "do not update on launch", takesValue: false }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "inventory_source", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: editSourcePlan,
    },
    {
      name: "source-delete", help: "awx-axi inventory source-delete <id|name> [--confirm] [--dry-run]", flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "inventory_source", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: deleteSourcePlan,
    },
    ...(["source-credential-add", "source-credential-remove"] as const).map((name) => ({ name, help: `awx-axi inventory ${name} <id|name> --credential <id|name> [--confirm] [--dry-run]`, flags: [{ name: "credential", description: "credential id or name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "inventory_source_credential", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: sourceCredentialPlan(name.endsWith("remove")) })),
    ...(["source-notification-add", "source-notification-remove"] as const).map((name) => ({ name, help: `awx-axi inventory ${name} <id|name> --event <event> --notification-template <id|name> [--confirm] [--dry-run]`, flags: [{ name: "event", description: "started, success, or error", takesValue: true }, { name: "notification-template", description: "notification template id or name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "inventory_source_notification", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: sourceNotificationPlan(name.endsWith("remove")) })),
    {
      name: "create",
      help: "awx-axi inventory create [<name>] [--organization <o>] [--kind <standard|smart>] [--host-filter <filter>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "inventory name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "kind", description: "inventory kind: standard or smart; host-filter implies smart", takesValue: true },
        { name: "host-filter", description: "smart inventory host filter", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "variables", description: "inventory variables YAML/JSON", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "inventory", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createInventoryPlan,
    },
    {
      name: "edit",
      help: "awx-axi inventory edit <id|name> [--name <n>] [--host-filter <filter>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "inventory name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "host-filter", description: "smart inventory host filter", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "variables", description: "inventory variables YAML/JSON", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "inventory", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editInventoryPlan,
    },
    {
      name: "delete",
      help: "awx-axi inventory delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "inventory", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteInventoryPlan,
    },
    {
      name: "sync",
      help: "awx-axi inventory sync <id|name> [--wait] [--confirm] [--dry-run]",
      flags: [
        { name: "wait", description: "wait for completion", takesValue: false },
        { name: "timeout", description: "wait timeout in seconds", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "inventory_update", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: syncPlan,
    },
    {
      name: "host-create",
      help: "awx-axi inventory host-create [<name>] --inventory <i|name> [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "host name", takesValue: true },
        { name: "inventory", description: "inventory id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "variables", description: "host variables YAML/JSON", takesValue: true },
        { name: "enabled", description: "enable host", takesValue: false },
        { name: "disabled", description: "disable host", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "host", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createHostPlan,
    },
    {
      name: "host-edit",
      help: "awx-axi inventory host-edit <id|name> [--name <n>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "host name", takesValue: true },
        { name: "inventory", description: "inventory id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "variables", description: "host variables YAML/JSON", takesValue: true },
        { name: "enabled", description: "enable host", takesValue: false },
        { name: "disabled", description: "disable host", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "host", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editHostPlan,
    },
    {
      name: "host-delete",
      help: "awx-axi inventory host-delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "host", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteHostPlan,
    },
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

export const inventoryDomain: Domain = {
  ...baseInventoryDomain,
  async run(args, context) {
    if (args[0] === "host" && (args[1] === "create" || args[1] === "edit" || args[1] === "delete" || args[1] === "bulk-create" || args[1] === "bulk-delete")) {
      return baseInventoryDomain.run([`host-${args[1]}`, ...args.slice(2)], context);
    }
    if ((args[0] === "group" || args[0] === "source") && args[1] !== undefined) {
      const action = args[1] === "create" || args[1] === "edit" || args[1] === "delete" ? `${args[0]}-${args[1]}` : `${args[0]}-${args.slice(1).join("-")}`;
      return baseInventoryDomain.run([action, ...args.slice(2)], context);
    }
    return baseInventoryDomain.run(args, context);
  },
};
