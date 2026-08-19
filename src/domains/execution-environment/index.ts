/**
 * The `execution-environment` domain: container images for job execution (design.md §7.10).
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive } from "../../core/mutations.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
import {
  defineDomain,
  read,
  readPaged,
  write,
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

function* createPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name.length === 0) throw validationError("`execution-environment create` needs a name argument or --name");
  if (typeof input.flags.image !== "string") throw validationError("`execution-environment create` needs --image");
  const payload: Record<string, unknown> = { name, image: input.flags.image };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.organization === "string") payload.organization = yield* resolveId(input.flags.organization, { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: "execution-environment create" });
  if (typeof input.flags.credential === "string") payload.credential = yield* resolveId(input.flags.credential, { listRoute: "credentials/", noun: "credential", listCommand: "credential list", command: "execution-environment create" });
  if (typeof input.flags.pull === "string") payload.pull = input.flags.pull;
  if (!isLive(input.flags)) return dryRun("create", "execution_environment", { name }, "POST execution_environments/", payload);
  const response = yield* write("execution_environments/", payload, { method: "POST", tag: "config" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `execution environment ${name}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "execution_environment", fields: { id, name: body.name ?? name, image: body.image ?? input.flags.image }, help: [`Run \`awx-axi execution-environment show ${id}\` to inspect environment`] });
}

function* editPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "execution_environments/", noun: "execution environment", listCommand: "execution-environment list", command: "execution-environment edit" });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.image === "string") payload.image = input.flags.image;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.organization === "string") payload.organization = yield* resolveId(input.flags.organization, { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: "execution-environment edit" });
  if (typeof input.flags.credential === "string") payload.credential = yield* resolveId(input.flags.credential, { listRoute: "credentials/", noun: "credential", listCommand: "credential list", command: "execution-environment edit" });
  if (typeof input.flags.pull === "string") payload.pull = input.flags.pull;
  if (!isLive(input.flags)) return dryRun("edit", "execution_environment", { execution_environment: id }, `PATCH execution_environments/${id}/`, payload);
  const response = yield* write(`execution_environments/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (response.status !== 200) throw errorForResponse(response, { subject: `execution environment ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return detailOutput({ label: "execution_environment", fields: { id, name: body.name ?? null, image: body.image ?? null }, help: [`Run \`awx-axi execution-environment show ${id}\` to inspect updated environment`] });
}

function* deletePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "execution_environments/", noun: "execution environment", listCommand: "execution-environment list", command: "execution-environment delete" });
  if (!isLive(input.flags)) return dryRun("delete", "execution_environment", { execution_environment: id }, `DELETE execution_environments/${id}/`);
  const response = yield* write(`execution_environments/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (response.status !== 204 && response.status !== 200 && response.status !== 202) throw errorForResponse(response, { subject: `execution environment ${id}` });
  return detailOutput({ label: "execution_environment", fields: { id, status: "deleted" } });
}

function* copyPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "execution_environments/", noun: "execution environment", listCommand: "execution-environment list", command: "execution-environment copy" });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (!isLive(input.flags)) return dryRun("copy", "execution_environment", { execution_environment: id }, `POST execution_environments/${id}/copy/`, payload);
  const response = yield* write(`execution_environments/${id}/copy/`, payload, { method: "POST", tag: "config" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `execution environment ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const copyId = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "execution_environment", fields: { id: copyId, name: body.name ?? null }, help: [`Run \`awx-axi execution-environment show ${copyId}\` to inspect copy`] });
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
    "  create|edit|delete|copy  execution environments",
    "  list  [--search <s>] [--organization <id>] [--type <type>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "create_execution_environment", "update_execution_environment", "delete_execution_environment",
    "list_execution_environments",
    "get_execution_environment",
    "list_execution_environment_unified_job_templates",
  ],
  subcommands: [
    {
      name: "create", help: "awx-axi execution-environment create [<name>] --image <image> [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "environment name", takesValue: true }, { name: "image", description: "container image", takesValue: true },
        { name: "description", description: "description", takesValue: true }, { name: "organization", description: "organization id or name", takesValue: true },
        { name: "credential", description: "registry credential id or name", takesValue: true }, { name: "pull", description: "pull policy", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false },
      ], positionals: { names: ["<name>"], required: 0 }, schema: { label: "execution_environment", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: createPlan,
    },
    {
      name: "edit", help: "awx-axi execution-environment edit <id|name> [--image <image>] [--pull <policy>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "environment name", takesValue: true }, { name: "image", description: "container image", takesValue: true },
        { name: "description", description: "description", takesValue: true }, { name: "organization", description: "organization id or name", takesValue: true },
        { name: "credential", description: "registry credential id or name", takesValue: true }, { name: "pull", description: "pull policy", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false },
      ], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "execution_environment", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: editPlan,
    },
    {
      name: "delete", help: "awx-axi execution-environment delete <id|name> [--confirm] [--dry-run]",
      flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }],
      positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "execution_environment", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: deletePlan,
    },
    {
      name: "copy", help: "awx-axi execution-environment copy <id|name> [--name <name>] [--confirm] [--dry-run]",
      flags: [{ name: "name", description: "copy name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }],
      positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "execution_environment", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: copyPlan,
    },
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
