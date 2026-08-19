/**
 * The `organization` domain: list and inspect AWX organizations (design.md v1 roadmap).
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

function* createPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name.length === 0) {
    throw validationError("`organization create` needs a name argument or --name", [
      "Run `awx-axi organization create <name>`",
    ]);
  }
  const payload: Record<string, unknown> = { name };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags["max-hosts"] === "string") payload.max_hosts = Number(input.flags["max-hosts"]);
  if (typeof input.flags["default-environment"] === "string") {
    payload.default_environment = yield* resolveId(input.flags["default-environment"], {
      listRoute: "execution_environments/", noun: "execution environment",
      listCommand: "execution-environment list", command: "organization create",
    });
  }
  if (!isLive(input.flags)) return dryRun("create", "organization", { name }, "POST organizations/", payload);
  const response = yield* write("organizations/", payload, { method: "POST", tag: "config" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `organization ${name}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "organization", fields: { id, name: body.name ?? name }, help: [`Run \`awx-axi organization show ${id}\` to inspect organization`] });
}

function* editPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: "organization edit" });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags["max-hosts"] === "string") payload.max_hosts = Number(input.flags["max-hosts"]);
  if (typeof input.flags["default-environment"] === "string") payload.default_environment = yield* resolveId(input.flags["default-environment"], { listRoute: "execution_environments/", noun: "execution environment", listCommand: "execution-environment list", command: "organization edit" });
  if (!isLive(input.flags)) return dryRun("edit", "organization", { organization: id }, `PATCH organizations/${id}/`, payload);
  const response = yield* write(`organizations/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (response.status !== 200) throw errorForResponse(response, { subject: `organization ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return detailOutput({ label: "organization", fields: { id, name: body.name ?? null }, help: [`Run \`awx-axi organization show ${id}\` to inspect updated organization`] });
}

function* deletePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: "organization delete" });
  if (!isLive(input.flags)) return dryRun("delete", "organization", { organization: id }, `DELETE organizations/${id}/`);
  const response = yield* write(`organizations/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (response.status !== 204 && response.status !== 200 && response.status !== 202) throw errorForResponse(response, { subject: `organization ${id}` });
  return detailOutput({ label: "organization", fields: { id, status: "deleted" } });
}

const ORGANIZATION_ASSOCIATIONS: Record<string, { flag: string; route: string; listRoute: string; noun: string; tag: "security" | "config" }> = {
  "team-add": { flag: "team", route: "teams", listRoute: "teams/", noun: "team", tag: "security" },
  "team-remove": { flag: "team", route: "teams", listRoute: "teams/", noun: "team", tag: "security" },
  "execution-environment-add": { flag: "execution-environment", route: "execution_environments", listRoute: "execution_environments/", noun: "execution environment", tag: "config" },
  "execution-environment-remove": { flag: "execution-environment", route: "execution_environments", listRoute: "execution_environments/", noun: "execution environment", tag: "config" },
  "notification-template-add": { flag: "notification-template", route: "notification_templates", listRoute: "notification_templates/", noun: "notification template", tag: "config" },
  "notification-template-remove": { flag: "notification-template", route: "notification_templates", listRoute: "notification_templates/", noun: "notification template", tag: "config" },
  "galaxy-credential-add": { flag: "credential", route: "galaxy_credentials", listRoute: "credentials/", noun: "credential", tag: "security" },
  "galaxy-credential-remove": { flag: "credential", route: "galaxy_credentials", listRoute: "credentials/", noun: "credential", tag: "security" },
};

function associationPlan(operation: string) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
  const spec = ORGANIZATION_ASSOCIATIONS[operation];
  if (spec === undefined) throw validationError("unsupported organization association");
  const organization = yield* resolveId(input.args[0] ?? "", { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: `organization ${operation}` });
  const value = input.flags[spec.flag];
  if (typeof value !== "string") throw validationError(`\`organization ${operation}\` needs --${spec.flag} id or name`);
  const target = yield* resolveId(value, { listRoute: spec.listRoute, noun: spec.noun, listCommand: spec.listRoute.slice(0, -1), command: `organization ${operation}` });
  const remove = operation.endsWith("-remove");
  const path = `organizations/${organization}/${spec.route}/`;
  const payload = remove ? { id: target, disassociate: true } : { id: target };
  if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", spec.noun, { organization, [spec.flag]: target }, `POST ${path}`, payload);
  const response = yield* write(path, payload, { method: "POST", tag: spec.tag });
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `organization ${organization}` });
  return detailOutput({ label: "organization_association", fields: { organization, [spec.flag]: target, status: remove ? "removed" : "added" } });
  };
}

function organizationNotificationPlan(remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const organization = yield* resolveId(input.args[0] ?? "", { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: `organization notification-${remove ? "remove" : "add"}` });
    const event = input.flags.event; if (typeof event !== "string" || !["started", "success", "error", "approval"].includes(event)) throw validationError("--event must be started, success, error, or approval");
    if (typeof input.flags["notification-template"] !== "string") throw validationError("organization notification association needs --notification-template");
    const template = yield* resolveId(input.flags["notification-template"], { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "organization notification" });
    const path = `organizations/${organization}/notification_templates_${event === "approval" ? "approvals" : event}/`; const payload = remove ? { id: template, disassociate: true } : { id: template };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", "notification_template", { organization, notification_template: template, event }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `organization ${organization} notifications` });
    return detailOutput({ label: "organization_notification", fields: { organization, notification_template: template, event, status: remove ? "removed" : "added" } });
  };
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
    "  create|edit|delete  organization configuration",
    "  team-add|team-remove  manage organization teams",
    "  execution-environment-add|execution-environment-remove  manage execution environments",
    "  notification-template-add|notification-template-remove  manage notifications",
    "  galaxy-credential-add|galaxy-credential-remove  manage Galaxy credentials",
    "  list  [--search <s>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_organizations", "get_organization", "create_organization", "update_organization", "delete_organization"],
  subcommands: [
    {
      name: "create",
      help: "awx-axi organization create [<name>] [--description <d>] [--max-hosts <n>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "organization name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "max-hosts", description: "maximum hosts", takesValue: true },
        { name: "default-environment", description: "default execution environment id or name", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "preview without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 }, schema: { label: "organization", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: createPlan,
    },
    {
      name: "edit",
      help: "awx-axi organization edit <id|name> [--name <n>] [--description <d>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "organization name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "max-hosts", description: "maximum hosts", takesValue: true },
        { name: "default-environment", description: "default execution environment id or name", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "preview without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "organization", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: editPlan,
    },
    {
      name: "delete", help: "awx-axi organization delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "preview without mutating", takesValue: false },
      ], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "organization", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: deletePlan,
    },
    ...(["notification-add", "notification-remove"] as const).map((name) => ({
      name, help: `awx-axi organization ${name} <id|name> --event <event> --notification-template <id|name> [--confirm] [--dry-run]`, flags: [{ name: "event", description: "started, success, error, or approval", takesValue: true }, { name: "notification-template", description: "notification template id or name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "organization_notification", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: organizationNotificationPlan(name.endsWith("remove")),
    })),
    ...Object.entries(ORGANIZATION_ASSOCIATIONS).map(([name, spec]) => ({
      name,
      help: `awx-axi organization ${name} <id|name> --${spec.flag} <id|name> [--confirm] [--dry-run]`,
      flags: [
        { name: spec.flag, description: `${spec.noun} id or name`, takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "preview without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "organization_association", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: associationPlan(name),
    })),
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
