/**
 * The `system-job` domain: read-only access to system job runs.
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
import { resolveUnifiedJob } from "../../core/resolve.js";

const DEFAULT_LIST_LIMIT = 100;
const EVENTS_LIMIT = 50;
const RELATION_LIMIT = 50;

const VALID_STATUSES = [
  "new",
  "pending",
  "waiting",
  "running",
  "successful",
  "failed",
  "error",
  "canceled",
  "canceling",
];

const LIST_SCHEMA = {
  label: "system_jobs",
  defaultFields: ["id", "name", "template", "status", "started", "finished"],
  fieldAllowlist: ["type", "created", "elapsed", "stdout", "created_by", "modified"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(`--limit needs a value for \`system-job ${subcommand}\`, got --limit`, [
      `Run \`awx-axi system-job ${subcommand} --limit ${fallback}\``,
    ]);
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`system-job ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi system-job ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function parseSystemJobId(raw: string | undefined, command: string): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw validationError(`\`system-job ${command}\` needs a numeric id, got "${raw ?? ""}"`, [
      `Run \`awx-axi system-job list\` to find a system job id`,
    ]);
  }
  return Number(raw);
}

function toRef(raw: unknown): string | null {
  const summary = (raw ?? {}) as Record<string, unknown>;
  const id = typeof summary.id === "number" ? summary.id : null;
  const name = typeof summary.name === "string" ? summary.name : null;
  return id === null || name === null ? null : `${id} (${name})`;
}

function* resolveSystemJobId(raw: string | undefined, command: string): Plan<number> {
  const id = parseSystemJobId(raw, command);
  const unified = yield* resolveUnifiedJob(id);
  if (unified.type !== "system_job") {
    const typeLabel = unified.type ?? "unknown";
    throw validationError(`\`system-job ${command}\` needs a system job id, ${id} is a ${typeLabel} job`, [
      `Run \`awx-axi job show ${id} --type ${typeLabel}\` to inspect this run`,
    ]);
  }
  return id;
}

function toSystemJobRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    template: toRef(summary.unified_job_template),
    status: typeof record.status === "string" ? record.status : "",
    type: typeof record.type === "string" ? record.type : null,
    started: typeof record.started === "string" ? record.started : null,
    finished: typeof record.finished === "string" ? record.finished : null,
  };
}

function parseTemplateId(raw: string | undefined, command: string): number {
  if (raw === undefined) {
    throw validationError(`--template on \`system-job ${command}\` needs a numeric template id`, [
      `Run \`awx-axi system-job-template list\` to find the template id`,
    ]);
  }
  if (!/^\d+$/.test(raw)) {
    throw validationError(`--template for \`system-job ${command}\` needs a positive integer, got ${raw}`, [
      `Run \`awx-axi system-job-template list\` to find the template id`,
    ]);
  }
  return Number(raw);
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.status === "string") {
    if (!VALID_STATUSES.includes(input.flags.status)) {
      throw validationError(`unknown --status "${input.flags.status}" for \`system-job list\``, [
        `valid statuses for \`system-job list\`: ${VALID_STATUSES.join(", ")}, all`,
      ]);
    }
    query.status = input.flags.status;
  }
  if (typeof input.flags.template === "string") {
    query.unified_job_template = parseTemplateId(input.flags.template, "list");
  }

  const paged = yield* readPaged("system_jobs/", query, limit);
  const rows = paged.rows.map(toSystemJobRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 system jobs found",
    help: [
      `Run \`awx-axi system-job show <id>\` for job details`,
      `Run \`awx-axi system-job events <id>\` for task events`,
      `Run \`awx-axi system-job notifications <id>\` for delivery state`,
    ],
  });
}

function* cancelPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveSystemJobId(input.args[0], "cancel");
  if (!isLive(input.flags)) return dryRun("cancel", "system_job", { system_job: id }, `POST system_jobs/${id}/cancel/`);
  const response = yield* write(`system_jobs/${id}/cancel/`, undefined, { method: "POST", tag: "operational" });
  if (response.status === 405) {
    const detail = yield* read(`system_jobs/${id}/`);
    if (detail.status === 200) {
      const body = (detail.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === "string" ? body.status : "unknown";
      if (!["new", "pending", "waiting", "running"].includes(status)) return detailOutput({ label: "system_job", fields: { id, status, message: "already finished, nothing to cancel (no-op)" }, help: [`Run \`awx-axi system-job show ${id}\` for details`] });
    }
    throw errorForResponse(response, { subject: `system job ${id}` });
  }
  if (response.status !== 202 && response.status !== 200) throw errorForResponse(response, { subject: `system job ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : "cancel_requested";
  return detailOutput({ label: "system_job", fields: { id, status }, help: [`Run \`awx-axi system-job show ${id}\` for details`] });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveSystemJobId(input.args[0], "show");
  const detail = yield* read(`system_jobs/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `system job ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const createdBy = (summary.created_by ?? {}) as Record<string, unknown>;
  const template = (summary.unified_job_template ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "system_job",
    fields: {
      id,
      name: body.name ?? null,
      status: body.status ?? null,
      type: body.type ?? null,
      template: toRef(template),
      started: body.started ?? null,
      finished: body.finished ?? null,
      elapsed: body.elapsed ?? null,
      launched_by: typeof createdBy.username === "string" ? createdBy.username : null,
      created: body.created ?? null,
      modified: body.modified ?? null,
    },
    help: [
      `Run \`awx-axi system-job events ${id}\` for task events`,
      `Run \`awx-axi system-job notifications ${id}\` for delivery state`,
    ],
  });
}

function toEventRow(raw: unknown): Row {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof rec.id === "number" ? rec.id : 0,
    event: typeof rec.event === "string" ? rec.event : "",
    host: typeof rec.host_name === "string" ? rec.host_name : null,
    task: typeof rec.task === "string" ? rec.task : null,
    failed: typeof rec.failed === "boolean" ? rec.failed : false,
    changed: typeof rec.changed === "boolean" ? rec.changed : false,
  };
}

function* eventsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveSystemJobId(input.args[0], "events");
  const limit = positiveLimit(input.flags.limit, EVENTS_LIMIT, "events");

  const query: Record<string, string | number | boolean> = {};

  if (input.flags.failed === true) {
    query.failed = true;
  }
  if (typeof input.flags.host === "string") {
    query.host_name = input.flags.host;
  }
  if (typeof input.flags.task === "string") {
    query.task__icontains = input.flags.task;
  }

  const paged = yield* readPaged(`system_jobs/${id}/events/`, query, limit);
  const rows = paged.rows.map(toEventRow);

  return listOutput({
    label: "events",
    rows,
    count: paged.count,
    empty: "0 system job events found",
    help: [`Run \`awx-axi system-job show ${id}\` for run-level status`],
  });
}

function toNotificationRow(raw: unknown): Row {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const summary = (rec.summary_fields ?? {}) as Record<string, unknown>;
  const template = (summary.notification_template ?? {}) as Record<string, unknown>;

  return {
    id: typeof rec.id === "number" ? rec.id : 0,
    template: toRef(template),
    status: typeof rec.status === "string" ? rec.status : "",
    created: typeof rec.created === "string" ? rec.created : null,
    errors: typeof rec.errors === "string" ? rec.errors : null,
    subject: typeof rec.subject === "string" ? rec.subject : null,
  };
}

function* notificationsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveSystemJobId(input.args[0], "notifications");
  const limit = positiveLimit(input.flags.limit, RELATION_LIMIT, "notifications");

  const paged = yield* readPaged(`system_jobs/${id}/notifications/`, {}, limit);
  const rows = paged.rows.map(toNotificationRow);

  return listOutput({
    label: "notifications",
    rows,
    count: paged.count,
    empty: "0 system job notifications found",
    help: [`Run \`awx-axi system-job show ${id}\` for run-level status`],
  });
}

export const systemJobDomain: Domain = defineDomain({
  name: "system-job",
  help: [
    "system-job: inspect system-run job history",
    "",
    "Subcommands:",
    "  cancel          <id> [--confirm] [--dry-run]",
    "  list            [--search <s>] [--template <id>] [--status <s>] [--limit <n>]",
    "  System jobs are generated records: create/edit/delete are not exposed; cancel is the only write.",
    "  show            <id>",
    "  events          <id> [--failed] [--host <h>] [--task <t>] [--limit <n>]",
    "  notifications   <id> [--limit <n>]",
  ].join("\n"),
  mcpEquivalents: [
    "list_system_jobs",
    "get_system_job",
    "get_system_job_events",
    "get_system_job_notifications",
  ],
  subcommands: [
    {
      name: "cancel", help: "awx-axi system-job cancel <id> [--confirm] [--dry-run]",
      flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id>"], required: 1 }, schema: { label: "system_job", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: cancelPlan,
    },
    {
      name: "list",
      help:
        "awx-axi system-job list [--search <s>] [--template <id>] [--status <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search system jobs", takesValue: true },
        { name: "template", description: "filter by template", takesValue: true },
        { name: "status", description: "filter by status", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi system-job show <id>` for run details"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi system-job show <id>",
      flags: [],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "system_job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [
        {
          outcome: "shown",
          suggestions: [
            `Run \`awx-axi system-job events <id>\` for event detail`,
            `Run \`awx-axi system-job notifications <id>\` for delivery state`,
          ],
        },
      ],
      plan: showPlan,
    },
    {
      name: "events",
      help: "awx-axi system-job events <id> [--failed] [--host <h>] [--task <t>] [--limit <n>]",
      flags: [
        { name: "failed", description: "only failed events", takesValue: false },
        { name: "host", description: "filter by host", takesValue: true },
        { name: "task", description: "filter by task", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "events", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: eventsPlan,
    },
    {
      name: "notifications",
      help: "awx-axi system-job notifications <id> [--limit <n>]",
      flags: [
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "notifications", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: notificationsPlan,
    },
  ],
});
