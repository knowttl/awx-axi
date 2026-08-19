/**
 * The `notification-template` domain: read notification-template resources.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive } from "../../core/mutations.js";
import { readFileSync, statSync } from "node:fs";
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
import { REDACTION, redact, redactValue } from "../../core/redact.js";
import { resolveId } from "../../core/resolve.js";

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "notification-templates",
  defaultFields: ["id", "name", "organization", "notification_type", "created"],
  fieldAllowlist: ["messages", "description", "modified", "notification_configuration"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`notification-template ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi notification-template ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`notification-template ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi notification-template ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseOrganization(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(`--organization for \`notification-template list\` must be a positive integer, got ${raw}`, [
      "Run `awx-axi notification-template list --organization <id>`",
    ]);
  }
  return value;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)} ... (truncated, ${value.length} chars total)`;
}

function toTemplateRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const organization = (summary.organization ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    organization:
      typeof organization.name === "string"
        ? `${organization.name} (${typeof organization.id === "number" ? organization.id : ""})`
        : null,
    notification_type:
      typeof record.notification_type === "string"
        ? record.notification_type
        : null,
    created: safeString(record.created),
  };
}

function redactableText(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  const redacted = redactValue(raw);
  return redact(
    typeof redacted === "string"
      ? redacted
      : JSON.stringify(redacted, null, 2),
  );
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  if (typeof input.flags.type === "string") {
    query.notification_type = input.flags.type;
  }

  if (typeof input.flags.organization === "string") {
    query.organization = parseOrganization(input.flags.organization);
  }

  const paged = yield* readPaged("notification_templates/", query, limit);
  const rows = paged.rows.map(toTemplateRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 notification templates found",
    help: [
      "Run `awx-axi notification-template show <id|name>` to inspect one template",
      "Run `awx-axi notification list --template <id>` to inspect sent notifications",
    ],
  });
}

function readJsonFile(path: string, label: string): Record<string, unknown> {
  let mode: number;
  try { mode = statSync(path).mode; } catch { throw validationError(`${label} could not be read`); }
  if ((mode & 0o077) !== 0) throw validationError(`${label} must have 0600 permissions`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* translated below */ }
  throw validationError(`${label} must contain a JSON object`);
}

function configFor(input: SubcommandInput): Record<string, unknown> {
  const path = typeof input.flags["configuration-file"] === "string"
    ? input.flags["configuration-file"] : input.flags["config-file"];
  return typeof path === "string" ? readJsonFile(path, "notification configuration file") : {};
}

function messagesFor(input: SubcommandInput): Record<string, unknown> | undefined {
  if (typeof input.flags["messages-file"] !== "string") return undefined;
  return readJsonFile(input.flags["messages-file"], "notification messages file");
}

function* createPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name.length === 0) throw validationError("`notification-template create` needs a name argument or --name");
  if (typeof input.flags.organization !== "string") throw validationError("`notification-template create` needs --organization id or name");
  if (typeof input.flags["notification-type"] !== "string") throw validationError("`notification-template create` needs --notification-type");
  const payload: Record<string, unknown> = {
    name,
    organization: yield* resolveId(input.flags.organization, { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: "notification-template create" }),
    notification_type: input.flags["notification-type"],
    notification_configuration: configFor(input),
  };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  const messages = messagesFor(input); if (messages !== undefined) payload.messages = messages;
  if (!isLive(input.flags)) return dryRun("create", "notification_template", { name }, "POST notification_templates/", {
    ...payload,
    notification_configuration: REDACTION,
    ...(messages === undefined ? {} : { messages: REDACTION }),
  });
  const hasSecretInput = typeof input.flags["configuration-file"] === "string"
    || typeof input.flags["config-file"] === "string"
    || typeof input.flags["messages-file"] === "string";
  const response = yield* write("notification_templates/", payload, { method: "POST", tag: hasSecretInput ? "security" : "config" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `notification template ${name}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "notification_template", fields: { id, name: body.name ?? name, notification_type: body.notification_type ?? payload.notification_type }, help: [`Run \`awx-axi notification-template show ${id}\` to inspect template`] });
}

function* editPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "notification-template edit" });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.organization === "string") payload.organization = yield* resolveId(input.flags.organization, { listRoute: "organizations/", noun: "organization", listCommand: "organization list", command: "notification-template edit" });
  if (typeof input.flags["notification-type"] === "string") payload.notification_type = input.flags["notification-type"];
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags["configuration-file"] === "string" || typeof input.flags["config-file"] === "string") payload.notification_configuration = configFor(input);
  const messages = messagesFor(input); if (messages !== undefined) payload.messages = messages;
  const preview = {
    ...payload,
    ...(payload.notification_configuration === undefined ? {} : { notification_configuration: REDACTION }),
    ...(messages === undefined ? {} : { messages: REDACTION }),
  };
  if (!isLive(input.flags)) return dryRun("edit", "notification_template", { notification_template: id }, `PATCH notification_templates/${id}/`, preview);
  const hasSecretInput = payload.notification_configuration !== undefined || messages !== undefined;
  const response = yield* write(`notification_templates/${id}/`, payload, { method: "PATCH", tag: hasSecretInput ? "security" : "config" });
  if (response.status !== 200) throw errorForResponse(response, { subject: `notification template ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return detailOutput({ label: "notification_template", fields: { id, name: body.name ?? null }, help: [`Run \`awx-axi notification-template show ${id}\` to inspect updated template`] });
}

function* deletePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "notification-template delete" });
  if (!isLive(input.flags)) return dryRun("delete", "notification_template", { notification_template: id }, `DELETE notification_templates/${id}/`);
  const response = yield* write(`notification_templates/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (response.status !== 204 && response.status !== 200 && response.status !== 202) throw errorForResponse(response, { subject: `notification template ${id}` });
  return detailOutput({ label: "notification_template", fields: { id, status: "deleted" } });
}

function* testPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "notification-template test" });
  if (!isLive(input.flags)) return dryRun("test", "notification_template", { notification_template: id }, `POST notification_templates/${id}/test/`);
  const response = yield* write(`notification_templates/${id}/test/`, undefined, { method: "POST", tag: "operational" });
  if (response.status !== 202 && response.status !== 200 && response.status !== 201) throw errorForResponse(response, { subject: `notification template ${id} test` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : "pending";
  return detailOutput({ label: "notification_test", fields: { notification_template: id, notification: body.notification ?? null, status } });
}

function* copyPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "notification-template copy" });
  const payload: Record<string, unknown> = {}; if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (!isLive(input.flags)) return dryRun("copy", "notification_template", { notification_template: id }, `POST notification_templates/${id}/copy/`, payload);
  const response = yield* write(`notification_templates/${id}/copy/`, payload, { method: "POST", tag: "security" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `notification template ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>; const copyId = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "notification_template", fields: { id: copyId, name: body.name ?? null }, help: [`Run \`awx-axi notification-template show ${copyId}\` to inspect copy`] });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "notification_templates/",
    noun: "notification-template",
    listCommand: "notification-template list",
    command: "notification-template show",
  });

  const detail = yield* read(`notification_templates/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `notification-template ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const organization = (summary.organization ?? {}) as Record<string, unknown>;
  const recent = (summary.recent_notifications ?? []) as unknown[];

  const notifications =
    recent.length === 0
      ? null
      : recent.map((row) => {
          const notification = row as Record<string, unknown>;
          return {
            id: typeof notification.id === "number" ? notification.id : null,
            status:
              typeof notification.status === "string"
                ? notification.status
                : null,
            created:
              typeof notification.created === "string"
                ? notification.created
                : null,
            error:
              typeof notification.error === "string"
                ? redact(notification.error)
                : null,
          };
        });

  const bodyText = redactableText(body.notification_configuration);

  return detailOutput({
    label: "notification-template",
    fields: {
      id,
      name: body.name ?? null,
      organization:
        typeof organization.name === "string"
          ? `${organization.name} (${typeof organization.id === "number" ? organization.id : "id unknown"})`
          : null,
      notification_type: body.notification_type ?? null,
      created: body.created ?? null,
      modified: body.modified ?? null,
      description: body.description ?? null,
      notification_configuration:
        bodyText === null ? null : truncateText(bodyText, 700),
      messages:
        body.messages === undefined
          ? null
          : redactableText(body.messages),
      recent_notifications: notifications,
    },
    help: [
      `Run \`awx-axi notification list --template ${id}\` to inspect send events`,
      "Run `awx-axi notification-template list` to return to the template list",
    ],
  });
}

export const notificationTemplateDomain: Domain = defineDomain({
  name: "notification-template",
  help: [
    "notification-template: AWX notification templates",
    "",
    "Subcommands:",
    "  create|edit|delete|test|copy  notification template management",
    "  list  [--search <s>] [--type <type>] [--organization <id>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_notification_templates", "get_notification_template", "create_notification_template", "update_notification_template", "delete_notification_template"],
  subcommands: [
    {
      name: "create", help: "awx-axi notification-template create [<name>] --organization <id|name> --notification-type <type> [--configuration-file <path>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "template name", takesValue: true }, { name: "organization", description: "organization id or name", takesValue: true },
        { name: "notification-type", description: "backend type", takesValue: true }, { name: "configuration-file", description: "0600 JSON configuration file", takesValue: true }, { name: "config-file", description: "alias for configuration file", takesValue: true }, { name: "messages-file", description: "JSON message templates file", takesValue: true }, { name: "description", description: "description", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false },
      ], positionals: { names: ["<name>"], required: 0 }, schema: { label: "notification_template", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: createPlan,
    },
    {
      name: "edit", help: "awx-axi notification-template edit <id|name> [--configuration-file <path>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "template name", takesValue: true }, { name: "organization", description: "organization id or name", takesValue: true }, { name: "notification-type", description: "backend type", takesValue: true }, { name: "configuration-file", description: "0600 JSON configuration file", takesValue: true }, { name: "config-file", description: "alias for configuration file", takesValue: true }, { name: "messages-file", description: "JSON message templates file", takesValue: true }, { name: "description", description: "description", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false },
      ], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "notification_template", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: editPlan,
    },
    {
      name: "delete", help: "awx-axi notification-template delete <id|name> [--confirm] [--dry-run]", flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "notification_template", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: deletePlan,
    },
    {
      name: "test", help: "awx-axi notification-template test <id|name> [--confirm] [--dry-run]", flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "notification_test", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: testPlan,
    },
    {
      name: "copy", help: "awx-axi notification-template copy <id|name> [--name <name>] [--confirm] [--dry-run]", flags: [{ name: "name", description: "copy name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "notification_template", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: copyPlan,
    },
    {
      name: "list",
      help: "awx-axi notification-template list [--search <s>] [--type <type>] [--organization <id>] [--limit <n>]",
      flags: [
        { name: "search", description: "search notification templates", takesValue: true },
        {
          name: "type",
          description: "template notification type (email, slack, webhook, etc.)",
          takesValue: true,
        },
        {
          name: "organization",
          description: "filter by organization id",
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
            "Run `awx-axi notification-template show <id|name>` for detail",
          ],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi notification-template show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "notification-template",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
