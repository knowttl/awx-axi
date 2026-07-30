/**
 * The `schedule` domain: scheduled unified-job runs (design.md §7.9).
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
  label: "schedules",
  defaultFields: ["id", "name", "template", "enabled", "next_run"],
  fieldAllowlist: [
    "description",
    "template",
    "enabled",
    "timezone",
    "next_run",
    "dtstart",
    "dtend",
    "rrule",
    "created",
    "modified",
  ],
} as const;

function summarizeTemplate(raw: unknown): string | null {
  const summary = (raw ?? {}) as Record<string, unknown>;
  const id = typeof summary.id === "number" ? summary.id : null;
  const name = typeof summary.name === "string" ? summary.name : null;

  if (id === null || name === null) {
    return null;
  }
  return `${id} (${name})`;
}

function toScheduleRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    template: summarizeTemplate(summary.unified_job_template),
    enabled:
      record.enabled === true
        ? "enabled"
        : record.enabled === false
          ? "disabled"
          : null,
    next_run: typeof record.next_run === "string" ? record.next_run : null,
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
      `--limit must be a positive integer for \`schedule ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi schedule ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function parseTemplateId(raw: string | undefined): number {
  if (raw === undefined) {
    throw validationError("--template needs a positive integer id");
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(`--template must be a positive integer, got ${raw}`);
  }
  return value;
}

function schedulePreview(body: Record<string, unknown>): string {
  const timezone =
    typeof body.timezone === "string" ? body.timezone : "controller default";
  const rrule = typeof body.rrule === "string" ? body.rrule : null;

  return rrule === null
    ? `zone ${timezone}: no recurrence rule configured`
    : `zone ${timezone}: ${rrule}`;
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");

  if (input.flags.enabled !== undefined && input.flags.disabled !== undefined) {
    throw validationError("choose one of --enabled or --disabled, not both");
  }

  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.template === "string") {
    query.unified_job_template = parseTemplateId(input.flags.template);
  }
  if (input.flags.enabled === true) {
    query.enabled = true;
  }
  if (input.flags.disabled === true) {
    query.enabled = false;
  }

  const paged = yield* readPaged("schedules/", query, limit);
  const rows = paged.rows.map(toScheduleRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 schedules found",
    help: [
      "Run `awx-axi schedule show <id|name>` to inspect schedule detail and timing",
      "Run `awx-axi schedule list --enabled` to list only enabled schedules",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "schedules/",
    noun: "schedule",
    listCommand: "schedule list",
    command: "schedule show",
  });

  const detail = yield* read(`schedules/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `schedule ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const templateSummary = summary.unified_job_template;
  const orgSummary = summary.organization;
  const org = (orgSummary ?? {}) as Record<string, unknown>;
  const templateRecord = (templateSummary ?? {}) as Record<string, unknown>;
  const templateId = typeof templateRecord.id === "number" ? templateRecord.id : null;
  const templateHelp = templateId === null
    ? "Run `awx-axi execution-environment list` to inspect runtime environments"
    : `Run \`awx-axi schedule list --template ${templateId}\` to find related schedules`;

  return detailOutput({
    label: "schedule",
    fields: {
      id,
      name: body.name ?? null,
      description: body.description ?? null,
      template: summarizeTemplate(templateSummary),
      template_type: body.unified_job_template_type ?? null,
      organization:
        typeof org.id === "number" && typeof org.name === "string"
          ? `${org.id} (${org.name})`
          : null,
      enabled: body.enabled === true ? "enabled" : "disabled",
      preview: schedulePreview(body),
      timezone: typeof body.timezone === "string" ? body.timezone : null,
      next_run: body.next_run ?? null,
      dtstart: body.dtstart ?? null,
      dtend: body.dtend ?? null,
    },
    help: [
      "Run `awx-axi execution-environment list` to inspect runtime environments",
      templateHelp,
    ],
  });
}

export const scheduleDomain: Domain = defineDomain({
  name: "schedule",
  help: [
    "schedule: scheduled unified-job runs",
    "",
    "Subcommands:",
    "  list    [--search <s>] [--template <id>] [--enabled] [--disabled] [--limit <n>]",
    "  show    <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_schedules",
    "get_schedule",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi schedule list [--search <s>] [--template <id>] [--enabled|--disabled] [--limit <n>]",
      flags: [
        { name: "search", description: "search schedules", takesValue: true },
        {
          name: "template",
          description: "filter schedules by unified job template id",
          takesValue: true,
        },
        {
          name: "enabled",
          description: "show only enabled schedules",
          takesValue: false,
        },
        {
          name: "disabled",
          description: "show only disabled schedules",
          takesValue: false,
        },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi schedule show <id|name>` for detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi schedule show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "schedule", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
