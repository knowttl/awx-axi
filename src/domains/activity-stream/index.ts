/**
 * The `activity-stream` domain: read AWX activity-stream events.
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
  label: "activity_stream",
  defaultFields: ["id", "operation", "object_type", "object1", "timestamp"],
  fieldAllowlist: ["object2", "actor", "object_association", "changes"],
} as const;

const SCOPE_FLAGS = [
  { flag: "job", query: "job" },
  { flag: "project", query: "project" },
  { flag: "inventory", query: "inventory" },
  { flag: "template", query: "job_template" },
  { flag: "workflow", query: "workflow_job_template" },
  { flag: "workflow-job", query: "workflow_job" },
  { flag: "organization", query: "organization" },
  { flag: "team", query: "team" },
  { flag: "user", query: "user" },
  { flag: "credential", query: "credential" },
] as const;

function positiveLimit(raw: string | true | undefined): number {
  if (raw === true) {
    throw validationError("--limit needs a value for `activity-stream list`", [
      "Run `awx-axi activity-stream list --limit 100`",
    ]);
  }
  if (raw === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for ` +
        "`activity-stream list`, got " +
        raw,
      ["Run `awx-axi activity-stream list --limit 100`"],
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

function parseOperation(raw: string): string {
  if (
    raw === "associate" ||
    raw === "create" ||
    raw === "delete" ||
    raw === "disassociate" ||
    raw === "update"
  ) {
    return raw;
  }
  throw validationError(
    `--operation for ` +
      "`activity-stream list` must be one of associate, create, delete, disassociate, update",
    [
      "Run `awx-axi activity-stream list --operation create` for object creation",
    ],
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)} ... (truncated, ${value.length} chars total)`;
}

function toActivityRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof record.id === "number" ? record.id : 0,
    operation: typeof record.operation === "string" ? record.operation : null,
    object_type: typeof record.object_type === "string" ? record.object_type : null,
    object1: typeof record.object1 === "string" ? record.object1 : null,
    object2: typeof record.object2 === "string" ? record.object2 : null,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit);
  const scopes = SCOPE_FLAGS.filter(
    (entry) => typeof (input.flags as Record<string, unknown>)[entry.flag] === "string",
  );

  if (scopes.length > 1) {
    throw validationError(
      "activity-stream list supports one scope flag at a time",
      [
        "Run `awx-axi activity-stream list --job <id>` to filter by one job",
      ],
    );
  }

  const query: Record<string, string | number | boolean> = {};

  if (scopes.length === 1) {
    const scope = scopes[0]!;
    const id = parsePositiveId(
      String((input.flags as Record<string, string | undefined>)[scope.flag]),
      `activity-stream list --${scope.flag}`,
    );
    query[scope.query] = id;
  }

  if (typeof input.flags.operation === "string") {
    query.operation = parseOperation(input.flags.operation);
  }

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("activity_stream/", query, limit);
  const rows = paged.rows.map(toActivityRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 activity_stream entries found",
    help: [
      "Run `awx-axi activity-stream show <id>` to inspect one entry",
      "Run `awx-axi activity-stream list --operation update` for only update events",
    ],
  });
}

function redactChanges(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  const safe = redactValue(raw);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  return truncate(redact(text), 1000);
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parsePositiveId(input.args[0] ?? "", "activity-stream show");
  const detail = yield* read(`activity_stream/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `activity stream ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "activity-stream",
    fields: {
      id: typeof body.id === "number" ? body.id : id,
      operation: body.operation ?? null,
      object_type: body.object_type ?? null,
      object1: body.object1 ?? null,
      object2: body.object2 ?? null,
      object_association: body.object_association ?? null,
      changes: redactChanges(body.changes),
      timestamp: body.timestamp ?? null,
    },
    help: ["Run `awx-axi activity-stream list` to return to the event list"],
  });
}

export const activityStreamDomain: Domain = defineDomain({
  name: "activity-stream",
  help: [
    "activity-stream: AWX audit trail events",
    "",
    "Subcommands:",
    "  list  [--operation <name>] [--search <s>] [scope] [--limit <n>]",
    "  show  <id>",
  ].join("\n"),
  mcpEquivalents: ["list_activity_stream", "get_activity_stream"],
  subcommands: [
    {
      name: "list",
      help: "awx-axi activity-stream list [--operation <associate|create|delete|disassociate|update>] [--search <s>] [--job <id>|--project <id>|--inventory <id>|--template <id>|--workflow <id>|--workflow-job <id>|--organization <id>|--team <id>|--user <id>|--credential <id>] [--limit <n>]",
      flags: [
        {
          name: "operation",
          description: "filter by operation",
          takesValue: true,
        },
        { name: "search", description: "search activity events", takesValue: true },
        { name: "job", description: "scope by job id", takesValue: true },
        {
          name: "project",
          description: "scope by project id",
          takesValue: true,
        },
        {
          name: "inventory",
          description: "scope by inventory id",
          takesValue: true,
        },
        {
          name: "template",
          description: "scope by job template id",
          takesValue: true,
        },
        {
          name: "workflow",
          description: "scope by workflow template id",
          takesValue: true,
        },
        {
          name: "workflow-job",
          description: "scope by workflow job id",
          takesValue: true,
        },
        {
          name: "organization",
          description: "scope by organization id",
          takesValue: true,
        },
        { name: "team", description: "scope by team id", takesValue: true },
        { name: "user", description: "scope by user id", takesValue: true },
        {
          name: "credential",
          description: "scope by credential id",
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
            "Run `awx-axi activity-stream show <id>` for one audit event",
          ],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi activity-stream show <id>",
      flags: [],
      positionals: { names: ["<id>"], required: 1 },
      schema: {
        label: "activity-stream",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
