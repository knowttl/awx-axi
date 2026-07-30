/**
 * The `system-job-template` domain: run templates for maintenance jobs.
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
const RELATED_LIMIT = 5;

const LIST_SCHEMA = {
  label: "system_job_templates",
  defaultFields: ["id", "name", "type", "last_run", "status"],
  fieldAllowlist: ["description", "organization", "created", "modified", "interval"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(`--limit needs a value for \`system-job-template ${subcommand}\`, got --limit`, [
      `Run \`awx-axi system-job-template ${subcommand} --limit ${fallback}\``,
    ]);
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`system-job-template ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi system-job-template ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function formatRef(raw: unknown): string | null {
  const summary = (raw ?? {}) as Record<string, unknown>;
  const id = typeof summary.id === "number" ? summary.id : null;
  const name = typeof summary.name === "string" ? summary.name : null;
  return id === null || name === null ? null : `${id} (${name})`;
}

function toSystemJobTemplateRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    type: typeof record.type === "string" ? record.type : null,
    status: typeof record.status === "string" ? record.status : "",
    last_run:
      typeof lastJob.id === "number"
        ? `${lastJob.id} ${lastJob.status ?? ""}`
        : null,
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");

  const query: Record<string, string | number | boolean> = {};
  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("system_job_templates/", query, limit);
  const rows = paged.rows.map(toSystemJobTemplateRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 system job templates found",
    help: [
      `Run \`awx-axi system-job-template show <id|name>\` to inspect template detail`,
      `Run \`awx-axi system-job list --template <template-id>\` to read template runs`,
    ],
  });
}

function toJobSummaryRows(rawRows: readonly unknown[]): Row[] {
  return rawRows.map((row) => {
    const rec = (row ?? {}) as Record<string, unknown>;
    const summary = (rec.summary_fields ?? {}) as Record<string, unknown>;
    const template = (summary.unified_job_template ?? {}) as Record<string, unknown>;
    return {
      id: typeof rec.id === "number" ? rec.id : 0,
      name: typeof rec.name === "string" ? rec.name : "",
      status: typeof rec.status === "string" ? rec.status : "",
      template: formatRef(template),
      started: typeof rec.started === "string" ? rec.started : null,
      finished: typeof rec.finished === "string" ? rec.finished : null,
    };
  });
}

function toScheduleRows(rawRows: readonly unknown[]): Row[] {
  return rawRows.map((row) => {
    const rec = (row ?? {}) as Record<string, unknown>;
    return {
      id: typeof rec.id === "number" ? rec.id : 0,
      name: typeof rec.name === "string" ? rec.name : "",
      enabled: rec.enabled === true ? "enabled" : rec.enabled === false ? "disabled" : null,
      next_run: typeof rec.next_run === "string" ? rec.next_run : null,
    };
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "system_job_templates/",
    noun: "system job template",
    listCommand: "system-job-template list",
    command: "system-job-template show",
  });

  const detail = yield* read(`system_job_templates/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `system job template ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const org = (summary.organization ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  const jobsPage = yield* readPaged(`system_job_templates/${id}/jobs/`, {}, RELATED_LIMIT);
  const schedulesPage = yield* readPaged(
    `system_job_templates/${id}/schedules/`,
    {},
    RELATED_LIMIT,
  );

  const fields: Record<string, unknown> = {
    id,
    name: body.name ?? null,
    type: body.type ?? null,
    description: body.description ?? null,
    organization:
      org.id !== undefined && org.name !== undefined
        ? `${org.id} (${org.name})`
        : null,
    status: body.status ?? null,
    last_run:
      typeof lastJob.id === "number"
        ? `${lastJob.id} ${lastJob.status ?? ""}`
        : null,
    jobs: toJobSummaryRows(jobsPage.rows),
    schedules: toScheduleRows(schedulesPage.rows),
    created: body.created ?? null,
    modified: body.modified ?? null,
  };

  return detailOutput({
    label: "system_job_template",
    fields,
    help: [
      `Run \`awx-axi system-job list --template ${id}\` to inspect recent system jobs`,
      `Run \`awx-axi schedule list --template ${id}\` to view linked schedules`,
    ],
  });
}

export const systemJobTemplateDomain: Domain = defineDomain({
  name: "system-job-template",
  help: [
    "system-job-template: system job templates and schedules",
    "",
    "Subcommands:",
    "  list    [--search <s>] [--limit <n>]",
    "  show    <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_system_job_templates",
    "get_system_job_template",
    "system_job_template_jobs",
    "system_job_template_schedules",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi system-job-template list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search system job templates", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi system-job-template show <id|name>` for template detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi system-job-template show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "system_job_template", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
