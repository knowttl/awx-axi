/**
 * The `notification-template` domain: read notification-template resources.
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
import { redact, redactValue } from "../../core/redact.js";
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
    query.organization = input.flags.organization;
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
    "  list  [--search <s>] [--type <type>] [--organization <id>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_notification_templates", "get_notification_template"],
  subcommands: [
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
