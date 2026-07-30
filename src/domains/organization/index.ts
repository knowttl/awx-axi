/**
 * The `organization` domain: list and inspect AWX organizations (design.md v1 roadmap).
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
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

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "organizations",
  defaultFields: ["id", "name", "max_hosts", "users", "projects"],
  fieldAllowlist: ["description", "custom_virtualenv", "created", "modified"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`organization ${subcommand}\`, got --limit`,
      [`Run \`awx-axi organization ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`organization ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi organization ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function relatedCount(summary: unknown, key: string): number | null {
  if (summary === undefined || summary === null || typeof summary !== "object") {
    return null;
  }
  const values = (summary as Record<string, unknown>)[key];
  return typeof values === "number" ? values : null;
}

function toOrganizationRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const counts = summary.related_field_counts ?? {};

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    max_hosts: typeof record.max_hosts === "number" ? record.max_hosts : null,
    users: relatedCount(counts, "users"),
    projects: relatedCount(counts, "projects"),
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("organizations/", query, limit);
  const rows = paged.rows.map(toOrganizationRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 organizations found",
    help: ["Run `awx-axi organization show <id|name>` to inspect one organization"],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "organizations/",
    noun: "organization",
    listCommand: "organization list",
    command: "organization show",
  });

  const detail = yield* read(`organizations/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `organization ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const counts = (summary.related_field_counts ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "organization",
    fields: {
      id,
      name: body.name ?? null,
      max_hosts: body.max_hosts ?? null,
      custom_virtualenv: body.custom_virtualenv ?? null,
      description: body.description ?? null,
      users: relatedCount(counts, "users"),
      admins: relatedCount(counts, "admins"),
      inventories: relatedCount(counts, "inventories"),
      teams: relatedCount(counts, "teams"),
      projects: relatedCount(counts, "projects"),
      job_templates: relatedCount(counts, "job_templates"),
      created: body.created ?? null,
      modified: body.modified ?? null,
    },
    help: ["Run `awx-axi user list` for users in the context of this domain"],
  });
}

export const organizationDomain: Domain = defineDomain({
  name: "organization",
  help: [
    "organization: AWX organizations",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_organizations", "get_organization"],
  subcommands: [
    {
      name: "list",
      help: "awx-axi organization list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search organizations", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: [
            "Run `awx-axi organization show <id|name>` for detail",
          ],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi organization show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "organization",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
