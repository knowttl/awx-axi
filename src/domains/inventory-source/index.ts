/**
 * The `inventory-source` domain: inspect dynamic inventory source definitions.
 *
 * Source creation, updates, and associations remain under `inventory`; this
 * noun exposes only GET-backed inspection.
 */
import { parse } from "yaml";

import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
import { REDACTION, redactValue } from "../../core/redact.js";
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
const UPDATE_LIMIT = 25;

const LIST_SCHEMA = {
  label: "inventory_sources",
  defaultFields: ["id", "name", "inventory", "organization", "source", "status"],
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

function relationReference(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  const relation = record(value);
  return formatReference(
    numberOrNull(relation.id),
    stringOrNull(relation.name),
  );
}

function inventoryContext(raw: unknown): {
  readonly inventory: string | null;
  readonly organization: string | null;
  readonly sourceProject: string | null;
  readonly credential: string | null;
} {
  const source = record(raw);
  const summary = record(source.summary_fields);
  const inventory = record(summary.inventory);
  const inventoryOrganization = record(inventory.organization);
  const organization = record(summary.organization);
  const credentials = Array.isArray(summary.credentials)
    ? summary.credentials[0]
    : undefined;

  return {
    inventory: formatReference(
      numberOrNull(inventory.id) ?? numberOrNull(source.inventory),
      stringOrNull(inventory.name),
    ),
    organization: formatReference(
      numberOrNull(organization.id) ??
        numberOrNull(inventoryOrganization.id) ??
        numberOrNull(inventory.organization_id),
      stringOrNull(organization.name) ?? stringOrNull(inventoryOrganization.name),
    ),
    sourceProject: relationReference(
      summary.source_project ?? source.source_project,
    ),
    credential: relationReference(
      summary.credential ?? credentials ?? source.credential,
    ),
  };
}

function positiveLimit(raw: string | true | undefined): number {
  if (raw === true) {
    throw validationError("--limit needs a value for `inventory-source list`", [
      "Run `awx-axi inventory-source list --limit 100`",
    ]);
  }
  if (raw === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`inventory-source list\`, got ${raw}`,
      ["Run `awx-axi inventory-source list --limit 100`"],
    );
  }
  return value;
}

function parseInventory(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--inventory must be a positive integer for \`inventory-source list\`, got ${raw}`,
      ["Run `awx-axi inventory-source list --inventory <id>`"],
    );
  }
  return value;
}

function toSourceRow(raw: unknown): Row {
  const source = record(raw);
  const context = inventoryContext(source);
  return {
    id: numberOrNull(source.id) ?? 0,
    name: stringOrNull(source.name),
    inventory: context.inventory,
    organization: context.organization,
    source: stringOrNull(source.source),
    status: stringOrNull(source.status),
  };
}

function toUpdateRow(raw: unknown): RecordValue {
  const update = record(raw);
  return {
    id: numberOrNull(update.id),
    name: stringOrNull(update.name),
    status: stringOrNull(update.status),
    created: stringOrNull(update.created),
    started: stringOrNull(update.started),
    finished: stringOrNull(update.finished),
    elapsed: numberOrNull(update.elapsed),
    failed: booleanOrNull(update.failed),
  };
}

/** Source variables are stored as JSON or YAML text by AWX. */
function safeSourceVars(value: unknown): unknown {
  if (typeof value !== "string") {
    return redactValue(value);
  }

  try {
    return redactValue(parse(value) as unknown);
  } catch {
    return REDACTION;
  }
}

function relationUpdate(value: unknown): string | null {
  const relation = record(value);
  return formatReference(
    numberOrNull(relation.id) ?? numberOrNull(value),
    stringOrNull(relation.name),
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
  if (typeof input.flags.source === "string") {
    query.source = input.flags.source;
  }
  if (typeof input.flags.status === "string") {
    query.status = input.flags.status;
  }

  const paged = yield* readPaged(
    "inventory_sources/",
    query,
    positiveLimit(input.flags.limit),
  );
  const rows = paged.rows.map(toSourceRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 inventory sources found",
    help: [
      "Run `awx-axi inventory-source show <id|name>` for source detail",
      "Run `awx-axi inventory list` to inspect the source inventory context",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "inventory_sources/",
    noun: "inventory source",
    listCommand: "inventory-source list",
    command: "inventory-source show",
  });

  const detail = yield* read(`inventory_sources/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `inventory source ${id}` });
  }

  const updates = yield* readPaged(
    `inventory_sources/${id}/inventory_updates/`,
    {},
    UPDATE_LIMIT,
  );

  const body = record(detail.body);
  const summary = record(body.summary_fields);
  const context = inventoryContext(body);
  const inventoryId = numberOrNull(body.inventory);
  const sourceVars = safeSourceVars(body.source_vars);

  return detailOutput({
    label: "inventory_source",
    fields: {
      id,
      name: stringOrNull(body.name),
      description: stringOrNull(body.description),
      inventory: context.inventory,
      organization: context.organization,
      source: stringOrNull(body.source),
      source_path: stringOrNull(body.source_path),
      source_vars: sourceVars,
      scm_branch: stringOrNull(body.scm_branch),
      source_project: context.sourceProject,
      credential: context.credential,
      enabled_var: stringOrNull(body.enabled_var),
      enabled_value: stringOrNull(body.enabled_value),
      host_filter: stringOrNull(body.host_filter),
      overwrite: booleanOrNull(body.overwrite),
      overwrite_vars: booleanOrNull(body.overwrite_vars),
      update_on_launch: booleanOrNull(body.update_on_launch),
      update_cache_timeout: numberOrNull(body.update_cache_timeout),
      timeout: numberOrNull(body.timeout),
      verbosity: numberOrNull(body.verbosity),
      limit: stringOrNull(body.limit) ?? numberOrNull(body.limit),
      status: stringOrNull(body.status),
      last_update_failed: booleanOrNull(body.last_update_failed),
      last_updated: stringOrNull(body.last_updated),
      current_update: relationUpdate(summary.current_update ?? body.current_update),
      last_update: relationUpdate(summary.last_update ?? body.last_update),
      total_updates: updates.count ?? updates.rows.length,
      updates: updates.rows.map(toUpdateRow).map((update) => redactValue(update)),
    },
    help: [
      inventoryId === null
        ? "Run `awx-axi inventory-source list` to inspect source definitions"
        : `Run \`awx-axi inventory sources ${inventoryId}\` to inspect this inventory's sources`,
      `Run \`awx-axi job list --type inventory-update\` to inspect update output`,
    ],
  });
}

export const inventorySourceDomain: Domain = defineDomain({
  name: "inventory-source",
  help: [
    "inventory-source: inspect dynamic inventory definitions and update history",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--name <n>] [--inventory <i>] [--source <type>] [--status <s>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: [],
  subcommands: [
    {
      name: "list",
      help: [
        "awx-axi inventory-source list [--search <s>] [--name <n>] [--inventory <i>] [--source <type>] [--status <s>] [--limit <n>]",
        "",
        "Lists visible inventory sources. `--search` searches source names and",
        "descriptions; `--source` filters AWX's source type field.",
        "",
        "Examples:",
        "  awx-axi inventory-source list --source ec2 --status successful",
        "  awx-axi inventory-source list --inventory 11 --limit 50",
      ].join("\n"),
      flags: [
        { name: "search", description: "search source names and descriptions", takesValue: true },
        { name: "name", description: "filter by exact source name", takesValue: true },
        { name: "inventory", description: "filter by inventory id", takesValue: true },
        { name: "source", description: "filter by source type", takesValue: true },
        { name: "status", description: "filter by current source status", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: [
            "Run `awx-axi inventory-source show <id|name>` for source detail",
          ],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: [
        "awx-axi inventory-source show <id|name>",
        "",
        "Shows source identity and context, safe source configuration, current",
        "and last update state, and direct update history.",
        "",
        "Examples:",
        "  awx-axi inventory-source show 21",
        "  awx-axi inventory-source show \"Nightly EC2 sync\"",
      ].join("\n"),
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "inventory_source", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
