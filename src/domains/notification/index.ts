/**
 * The `notification` domain: read notification delivery records.
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

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "notifications",
  defaultFields: ["id", "notification_type", "status", "template", "created"],
  fieldAllowlist: ["recipients", "error", "subject", "notifications_sent"],
} as const;

const SCOPE_FLAGS = [
  { flag: "job", route: "jobs" },
  { flag: "workflow-job", route: "workflow_jobs" },
  { flag: "project-update", route: "project_updates" },
  { flag: "inventory-update", route: "inventory_updates" },
  { flag: "ad-hoc", route: "ad_hoc_commands" },
  { flag: "system-job", route: "system_jobs" },
] as const;

function positiveLimit(raw: string | true | undefined): number {
  if (raw === true) {
    throw validationError("--limit needs a value for `notification list`", [
      "Run `awx-axi notification list --limit 100`",
    ]);
  }
  if (raw === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for ` +
        "`notification list`, got " +
        raw,
      ["Run `awx-axi notification list --limit 100`"],
    );
  }
  return value;
}

function parsePositiveId(raw: string, command: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(`--id for ${command} must be a positive integer, got ${raw}`, [
      `Run awx-axi ${command} <id>`,
    ]);
  }
  return value;
}

function parseTemplateId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(`--template for \`notification list\` must be a positive integer, got ${raw}`, [
      "Run `awx-axi notification list --template <id>`",
    ]);
  }
  return value;
}

function parseStatus(raw: string): string {
  if (raw === "all") {
    return "";
  }
  if (raw === "pending" || raw === "successful" || raw === "failed") {
    return raw;
  }
  throw validationError(
    `--status for ` +
      "`notification list` must be one of pending, successful, failed, all",
    ["Run `awx-axi notification list --status failed` for failed only"],
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)} ... (truncated, ${value.length} chars total)`;
}

function toNotificationRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const template = (summary.notification_template ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    notification_type:
      typeof record.notification_type === "string"
        ? record.notification_type
        : null,
    status: typeof record.status === "string" ? record.status : null,
    template:
      typeof template.name === "string"
        ? template.name
        : null,
    created: typeof record.created === "string" ? record.created : null,
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit);
  const scopeMatches = SCOPE_FLAGS.filter(
    (entry) => typeof (input.flags as Record<string, unknown>)[entry.flag] === "string",
  );

  if (scopeMatches.length > 1) {
    throw validationError(
      "--job, --workflow-job, --project-update, --inventory-update, --ad-hoc, and --system-job cannot be combined",
      [
        "Run `awx-axi notification list --job <id>` for one scope at a time",
      ],
    );
  }

  let route = "notifications/";
  if (scopeMatches.length === 1) {
    const selection = scopeMatches[0]!;
    const id = parsePositiveId(
      String((input.flags as Record<string, string | true | undefined>)[selection.flag]),
      `notification list --${selection.flag}`,
    );
    route = `${selection.route}/${id}/notifications/`;
  }

  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.status === "string") {
    const status = parseStatus(input.flags.status);
    if (status !== "") {
      query.status = status;
    }
  }

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  if (typeof input.flags.template === "string") {
    query.notification_template = parseTemplateId(input.flags.template);
  }

  const paged = yield* readPaged(route, query, limit);
  const rows = paged.rows.map(toNotificationRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 notifications found",
    help: [
      "Run `awx-axi notification show <id>` to inspect one delivery",
      "Run `awx-axi notification list --status all` for all statuses",
    ],
  });
}

function redactBody(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  const safe = redactValue(raw);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  return truncate(redact(text), 1000);
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parsePositiveId(input.args[0] ?? "", "notification show");

  const detail = yield* read(`notifications/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `notification ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const template = (summary.notification_template ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "notification",
    fields: {
      id,
      status: body.status ?? null,
      notification_type: body.notification_type ?? null,
      template:
        typeof template.name === "string"
          ? `${template.name} (${typeof template.id === "number" ? template.id : ""})`
          : null,
      error: body.error === undefined ? null : redact(String(body.error)),
      notifications_sent: body.notifications_sent ?? null,
      recipients: body.recipients ?? null,
      subject: body.subject === undefined ? null : redact(String(body.subject)),
      body: redactBody(body.body),
      created: body.created ?? null,
    },
    help: ["Run `awx-axi notification list` to inspect more notifications"],
  });
}

export const notificationDomain: Domain = defineDomain({
  name: "notification",
  help: [
    "notification: AWX notification deliveries",
    "",
    "Subcommands:",
    "  list   [--status <pending|successful|failed|all>] [--search <s>] [--template <id>] [--scope] [--limit <n>]",
    "  show   <id>",
  ].join("\n"),
  mcpEquivalents: ["list_notifications", "get_notification"],
  subcommands: [
    {
      name: "list",
      help: "awx-axi notification list [--status <pending|successful|failed|all>] [--search <s>] [--template <id>] [--job <id>|--workflow-job <id>|--project-update <id>|--inventory-update <id>|--ad-hoc <id>|--system-job <id>] [--limit <n>]",
      flags: [
        { name: "status", description: "filter by status", takesValue: true },
        { name: "search", description: "search notifications", takesValue: true },
        {
          name: "template",
          description: "filter by notification template id",
          takesValue: true,
        },
        { name: "job", description: "scope by job id", takesValue: true },
        {
          name: "workflow-job",
          description: "scope by workflow job id",
          takesValue: true,
        },
        {
          name: "project-update",
          description: "scope by project update id",
          takesValue: true,
        },
        {
          name: "inventory-update",
          description: "scope by inventory update id",
          takesValue: true,
        },
        { name: "ad-hoc", description: "scope by ad hoc command id", takesValue: true },
        {
          name: "system-job",
          description: "scope by system job id",
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
          suggestions: ["Run `awx-axi notification show <id>` for delivery detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi notification show <id>",
      flags: [],
      positionals: { names: ["<id>"], required: 1 },
      schema: {
        label: "notification",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
