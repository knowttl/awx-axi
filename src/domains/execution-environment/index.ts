/**
 * The `execution-environment` domain: container images for job execution (design.md §7.10).
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
const TEMPLATES_LIMIT = 200;

const LIST_SCHEMA = {
  label: "execution_environments",
  defaultFields: ["id", "name", "type", "organization", "image"],
  fieldAllowlist: ["description", "managed", "created", "modified"],
} as const;

function toExecutionEnvironmentRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const orgSummary = summary.organization ?? {};
  const org = orgSummary as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    type: typeof record.type === "string" ? record.type : null,
    organization:
      typeof org.id === "number" && typeof org.name === "string"
        ? `${org.id} (${org.name})`
        : null,
    image: typeof record.image === "string" ? record.image : null,
  };
}

function toTemplateRef(raw: unknown): {
  id: number;
  name: string;
  type: string;
} {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    type: typeof record.type === "string" ? record.type : "",
  };
}

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (typeof raw !== "string") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`execution-environment ${subcommand}\`, got ${raw}`,
      [
        `Run \`awx-axi execution-environment ${subcommand} --limit ${fallback}\``,
      ],
    );
  }
  return value;
}

function parseOrganization(raw: string | undefined, subcommand: string): number {
  if (raw === undefined) {
    throw validationError(
      `--organization needs a positive integer id for execution-environment ${subcommand}`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--organization must be a positive integer for \`execution-environment ${subcommand}\`, got ${raw}`,
    );
  }
  return value;
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");

  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.type === "string") {
    query.type = input.flags.type;
  }
  if (typeof input.flags.organization === "string") {
    query.organization = parseOrganization(input.flags.organization, "list");
  }

  const paged = yield* readPaged("execution_environments/", query, limit);
  const rows = paged.rows.map(toExecutionEnvironmentRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 execution environments found",
    help: [
      "Run `awx-axi execution-environment show <id|name>` to inspect templates using it",
      "Run `awx-axi template list --search <s>` for a template to pair with an execution environment",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "execution_environments/",
    noun: "execution environment",
    listCommand: "execution-environment list",
    command: "execution-environment show",
  });

  const detail = yield* read(`execution_environments/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `execution environment ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const orgSummary = summary.organization;
  const org = (orgSummary ?? {}) as Record<string, unknown>;
  const createdBy = (summary.created_by ?? {}) as Record<string, unknown>;
  const modifiedBy = (summary.modified_by ?? {}) as Record<string, unknown>;

  const templates = yield* readPaged(
    `execution_environments/${id}/unified_job_templates/`,
    {},
    TEMPLATES_LIMIT,
  );
  const templateRefs = templates.rows.map(toTemplateRef).filter((template) => template.id > 0);

  return detailOutput({
    label: "execution_environment",
    fields: {
      id,
      name: body.name ?? null,
      type: body.type ?? null,
      managed: body.managed === true ? "managed" : "custom",
      image: body.image ?? null,
      organization:
        typeof org.id === "number" && typeof org.name === "string"
          ? `${org.id} (${org.name})`
          : null,
      created_by:
        typeof createdBy.id === "number" && typeof createdBy.name === "string"
          ? `${createdBy.id} (${createdBy.name})`
          : null,
      modified_by:
        typeof modifiedBy.id === "number" && typeof modifiedBy.name === "string"
          ? `${modifiedBy.id} (${modifiedBy.name})`
          : null,
      created: body.created ?? null,
      modified: body.modified ?? null,
      unified_job_templates: templateRefs,
    },
    help: [
      `Run \`awx-axi execution-environment show ${id}\` to verify template compatibility`,
      "Run `awx-axi template list --search <s>` to find a template to reuse this environment",
    ],
  });
}

export const executionEnvironmentDomain: Domain = defineDomain({
  name: "execution-environment",
  help: [
    "execution-environment: execution environments and associated templates",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--organization <id>] [--type <type>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_execution_environments",
    "get_execution_environment",
    "list_execution_environment_unified_job_templates",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi execution-environment list [--search <s>] [--organization <id>] [--type <type>] [--limit <n>]",
      flags: [
        { name: "search", description: "search execution environments", takesValue: true },
        {
          name: "organization",
          description: "filter by organization id",
          takesValue: true,
        },
        {
          name: "type",
          description: "filter by execution environment type",
          takesValue: true,
        },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: [
            "Run `awx-axi execution-environment show <id|name>` for template associations",
          ],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi execution-environment show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "execution_environment",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
