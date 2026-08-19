/**
 * The `schedule` domain: scheduled unified-job runs (design.md §7.9).
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive, parseInteger } from "../../core/mutations.js";
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

function* createSchedulePlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name === "") {
    throw validationError("`schedule create` needs a schedule name argument or --name", [
      "Provide a name, e.g. `awx-axi schedule create \"Nightly Sync\" --rrule \"DTSTART:20250101T000000Z RRULE:FREQ=DAILY\" --template 12`",
    ]);
  }

  const payload: Record<string, unknown> = { name };

  if (typeof input.flags.template === "string") {
    payload.unified_job_template = yield* resolveId(input.flags.template, {
      listRoute: "unified_job_templates/",
      noun: "unified job template",
      listCommand: "template list",
      command: "schedule create",
    });
  }

  if (typeof input.flags.rrule === "string") payload.rrule = input.flags.rrule;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (input.flags.enabled === true) payload.enabled = true;
  if (input.flags.disabled === true) payload.enabled = false;
  if (typeof input.flags["extra-vars"] === "string") {
    try {
      payload.extra_data = JSON.parse(input.flags["extra-vars"]);
    } catch {
      payload.extra_data = input.flags["extra-vars"];
    }
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "schedule",
        name,
        would_send: "POST schedules/",
        payload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("schedules/", payload, { method: "POST", tag: "config" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `schedule ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "schedule",
    fields: {
      id,
      name: body.name ?? name,
      enabled: body.enabled === true ? "enabled" : "disabled",
    },
    help: [`Run \`awx-axi schedule show ${id}\` to inspect schedule`],
  });
}

function* editSchedulePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "schedules/",
    noun: "schedule",
    listCommand: "schedule list",
    command: "schedule edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.template === "string") {
    payload.unified_job_template = yield* resolveId(input.flags.template, {
      listRoute: "unified_job_templates/",
      noun: "unified job template",
      listCommand: "template list",
      command: "schedule edit",
    });
  }
  if (typeof input.flags.rrule === "string") payload.rrule = input.flags.rrule;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (input.flags.enabled === true) payload.enabled = true;
  if (input.flags.disabled === true) payload.enabled = false;
  if (typeof input.flags["extra-vars"] === "string") {
    try {
      payload.extra_data = JSON.parse(input.flags["extra-vars"]);
    } catch {
      payload.extra_data = input.flags["extra-vars"];
    }
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        schedule: id,
        would_send: `PATCH schedules/${id}/`,
        payload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`schedules/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `schedule ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "schedule",
    fields: {
      id,
      name: body.name ?? null,
      enabled: body.enabled === true ? "enabled" : "disabled",
    },
    help: [`Run \`awx-axi schedule show ${id}\` to inspect updated schedule`],
  });
}

const SCHEDULE_ASSOCIATIONS: Record<string, { flag: string; route: string; listRoute: string; noun: string }> = {
  "credential-add": { flag: "credential", route: "credentials", listRoute: "credentials/", noun: "credential" },
  "credential-remove": { flag: "credential", route: "credentials", listRoute: "credentials/", noun: "credential" },
  "label-add": { flag: "label", route: "labels", listRoute: "labels/", noun: "label" },
  "label-remove": { flag: "label", route: "labels", listRoute: "labels/", noun: "label" },
  "instance-group-add": { flag: "instance-group", route: "instance_groups", listRoute: "instance_groups/", noun: "instance group" },
  "instance-group-remove": { flag: "instance-group", route: "instance_groups", listRoute: "instance_groups/", noun: "instance group" },
};

function associationPlan(operation: string) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const spec = SCHEDULE_ASSOCIATIONS[operation]; if (spec === undefined) throw validationError("unsupported schedule association");
    const schedule = yield* resolveId(input.args[0] ?? "", { listRoute: "schedules/", noun: "schedule", listCommand: "schedule list", command: `schedule ${operation}` });
    const raw = input.flags[spec.flag]; if (typeof raw !== "string") throw validationError(`\`schedule ${operation}\` needs --${spec.flag} id or name`);
    const target = spec.flag === "credential"
    ? yield* resolveId(raw, { listRoute: spec.listRoute, noun: spec.noun, listCommand: "credential list", command: `schedule ${operation}` })
    : parseInteger(raw, `--${spec.flag}`, 1);
    const remove = operation.endsWith("-remove"); const path = `schedules/${schedule}/${spec.route}/`; const payload = remove ? { id: target, disassociate: true } : { id: target };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", spec.noun, { schedule, [spec.flag]: target }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: spec.flag === "credential" ? "security" : "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `schedule ${schedule}` });
    return detailOutput({ label: "schedule_association", fields: { schedule, [spec.flag]: target, status: remove ? "removed" : "added" } });
  };
}

function* deleteSchedulePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "schedules/",
    noun: "schedule",
    listCommand: "schedule list",
    command: "schedule delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        schedule: id,
        would_send: `DELETE schedules/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`schedules/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `schedule ${id}` });
  }

  return detailOutput({
    label: "schedule",
    fields: {
      id,
      status: "deleted",
    },
  });
}

export const scheduleDomain: Domain = defineDomain({
  name: "schedule",
  help: [
    "schedule: scheduled unified-job runs",
    "",
    "Subcommands:",
    "  create  [<name>] [--template <id|name>] [--rrule <rrule>] [--confirm] [--dry-run]",
    "  edit    <id|name> [--name <n>] [--confirm] [--dry-run]",
    "  delete  <id|name> [--confirm] [--dry-run]",
    "  list    [--search <s>] [--template <id>] [--enabled] [--disabled] [--limit <n>]",
    "  show    <id|name>",
    "  credential-add|credential-remove, label-add|label-remove, instance-group-add|instance-group-remove <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_schedules",
    "get_schedule",
    "create_schedule",
    "update_schedule",
    "delete_schedule",
  ],
  subcommands: [
    ...Object.entries(SCHEDULE_ASSOCIATIONS).map(([name, spec]) => ({ name, help: `awx-axi schedule ${name} <id|name> --${spec.flag} <${spec.flag === "credential" ? "id|name" : "id"}> [--confirm] [--dry-run]`, flags: [{ name: spec.flag, description: `${spec.noun} ${spec.flag === "credential" ? "id or name" : "id"}`, takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "schedule_association", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: associationPlan(name) })),
    {
      name: "create",
      help: "awx-axi schedule create [<name>] [--template <id|name>] [--rrule <rrule>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "schedule name", takesValue: true },
        { name: "template", description: "unified job template id or name", takesValue: true },
        { name: "rrule", description: "recurrence rule string", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "enabled", description: "enable schedule", takesValue: false },
        { name: "disabled", description: "disable schedule", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "schedule", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createSchedulePlan,
    },
    {
      name: "edit",
      help: "awx-axi schedule edit <id|name> [--name <n>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "schedule name", takesValue: true },
        { name: "template", description: "unified job template id or name", takesValue: true },
        { name: "rrule", description: "recurrence rule string", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "enabled", description: "enable schedule", takesValue: false },
        { name: "disabled", description: "disable schedule", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "schedule", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editSchedulePlan,
    },
    {
      name: "delete",
      help: "awx-axi schedule delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "schedule", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteSchedulePlan,
    },
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
