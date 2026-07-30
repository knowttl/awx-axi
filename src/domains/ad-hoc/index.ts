/**
 * The `ad-hoc` domain: inspect ad hoc command runs (design.md §7.2).
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, rawRegion, type Row } from "../../core/output.js";
import {
  defineDomain,
  read,
  readPaged,
  readText,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";

const DEFAULT_LIST_LIMIT = 100;
const EVENTS_LIMIT = 50;

const LIST_SCHEMA = {
  label: "ad_hoc_commands",
  defaultFields: ["id", "name", "status", "created", "started", "finished"],
  fieldAllowlist: ["inventory", "credential", "elapsed", "type", "arguments"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(`--limit needs a value for \`ad-hoc ${subcommand}\`, got --limit`, [
      `Run \`awx-axi ad-hoc ${subcommand} --limit ${fallback}\``,
    ]);
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`ad-hoc ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi ad-hoc ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function parseAdHocId(raw: string | undefined, command: string): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw validationError(`\`ad-hoc ${command}\` needs a numeric id, got "${raw ?? ""}"`, [
      `Run \`awx-axi ad-hoc list\` to find a command id`,
    ]);
  }
  return Number(raw);
}

function formatRef(raw: unknown): string | null {
  const summary = (raw ?? {}) as Record<string, unknown>;
  const id = typeof summary.id === "number" ? summary.id : null;
  const name = typeof summary.name === "string" ? summary.name : null;
  return id === null || name === null ? null : `${id} (${name})`;
}

function toAdHocRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    status: typeof record.status === "string" ? record.status : "",
    created: typeof record.created === "string" ? record.created : null,
    started: typeof record.started === "string" ? record.started : null,
    finished: typeof record.finished === "string" ? record.finished : null,
    inventory: formatRef(summary.inventory),
    credential: formatRef(summary.credential),
  };
}

function toEventRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof record.id === "number" ? record.id : 0,
    event: typeof record.event === "string" ? record.event : "",
    host: typeof record.host_name === "string" ? record.host_name : null,
    task: typeof record.task === "string" ? record.task : null,
    failed: typeof record.failed === "boolean" ? record.failed : false,
    changed: typeof record.changed === "boolean" ? record.changed : false,
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("ad_hoc_commands/", query, limit);
  const rows = paged.rows.map(toAdHocRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 ad-hoc commands found",
    help: [
      `Run \`awx-axi ad-hoc show <id>\` to inspect command detail`,
      `Run \`awx-axi ad-hoc stdout <id>\` to read command output`,
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseAdHocId(input.args[0], "show");
  const detail = yield* read(`ad_hoc_commands/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `ad-hoc command ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "ad_hoc_command",
    fields: {
      id,
      name: body.name ?? null,
      status: body.status ?? null,
      created: body.created ?? null,
      started: body.started ?? null,
      finished: body.finished ?? null,
      elapsed: body.elapsed ?? null,
      inventory: formatRef(summary.inventory),
      credential: formatRef(summary.credential),
      type: body.type ?? null,
      module: body.module_name ?? null,
    },
    help: [
      `Run \`awx-axi ad-hoc events ${id}\` to inspect task events`,
      `Run \`awx-axi ad-hoc stdout ${id}\` to read command output`,
    ],
  });
}

function parseLinesRange(
  raw: string | undefined,
  command: string,
): { startLine: number; endLine: number } {
  if (raw === undefined) {
    return { startLine: 1, endLine: 1000 };
  }
  const match = /^(\d+)-(\d+)$/.exec(raw);
  if (match === null) {
    throw validationError(`malformed --lines range "${raw}" for \`ad-hoc ${command}\``, [
      "Run `awx-axi ad-hoc stdout <id> --lines 1-200` to read from the start",
    ]);
  }
  return {
    startLine: Number(match[1]),
    endLine: Number(match[2]),
  };
}

function* stdoutPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseAdHocId(input.args[0], "stdout");
  const query: Record<string, string | number | boolean> = { format: "txt" };
  if (typeof input.flags.lines === "string") {
    const { startLine, endLine } = parseLinesRange(input.flags.lines, "stdout");
    query.start_line = startLine;
    query.end_line = endLine;
  } else if (typeof input.flags.tail === "string") {
    query.tail = Number(input.flags.tail);
  }

  const textRes = yield* readText(`ad_hoc_commands/${id}/stdout/`, query);
  if (textRes.tooLarge) {
    const sizeMb = ((textRes.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1);
    const limitMb = ((textRes.displayLimitBytes ?? 0) / (1024 * 1024)).toFixed(1);
    throw new AxiError(
      `this ad-hoc output is ${sizeMb} MB, above the controller's ${limitMb} MB display limit`,
      "OUTPUT_TOO_LARGE",
      [
        `Run \`awx-axi ad-hoc stdout ${id} --lines 1-200\` for the first lines`,
        `Run \`awx-axi ad-hoc events ${id}\` for event-level detail`,
      ],
    );
  }

  const header = {
    ad_hoc_stdout: {
      id,
      lines: `${textRes.rangeStart}-${textRes.rangeEnd} of ${textRes.absoluteEnd}`,
    },
  };

  return rawRegion({
    header,
    label: "stdout",
    body: textRes.content,
    help: [
      `Run \`awx-axi ad-hoc stdout ${id} --lines 1-200\` to read from the start`,
      `Run \`awx-axi ad-hoc events ${id}\` for event-level detail`,
    ],
  });
}

function* eventsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseAdHocId(input.args[0], "events");
  const limit = positiveLimit(input.flags.limit, EVENTS_LIMIT, "events");

  const query: Record<string, string | number | boolean> = {};
  if (typeof input.flags.host === "string") {
    query.host_name = input.flags.host;
  }
  if (typeof input.flags.task === "string") {
    query.task__icontains = input.flags.task;
  }

  const paged = yield* readPaged(`ad_hoc_commands/${id}/events/`, query, limit);
  const rows = paged.rows.map(toEventRow);

  return listOutput({
    label: "events",
    rows,
    count: paged.count,
    empty: "0 events found",
    help: [
      `Run \`awx-axi ad-hoc stdout ${id}\` for command output`,
    ],
  });
}

export const adHocDomain: Domain = defineDomain({
  name: "ad-hoc",
  help: [
    "ad-hoc: inspect existing ad hoc command runs",
    "",
    "Subcommands:",
    "  list     [--search <s>] [--limit <n>]",
    "  show     <id>",
    "  events   <id> [--host <h>] [--task <t>] [--limit <n>]",
    "  stdout   <id> [--tail <n> | --lines <a-b>]",
  ].join("\n"),
  mcpEquivalents: [
    "list_ad_hoc_commands",
    "get_ad_hoc_command",
    "get_ad_hoc_command_events",
    "get_ad_hoc_command_stdout",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi ad-hoc list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search ad-hoc commands", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi ad-hoc show <id>",
      flags: [],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "ad_hoc_command", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "events",
      help: "awx-axi ad-hoc events <id> [--host <h>] [--task <t>] [--limit <n>]",
      flags: [
        { name: "host", description: "filter by host name", takesValue: true },
        { name: "task", description: "filter by task name", takesValue: true },
        { name: "limit", description: "max events", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "events", defaultFields: ["id", "event", "host", "task", "failed"], fieldAllowlist: [] },
      suggestions: [],
      plan: eventsPlan,
    },
    {
      name: "stdout",
      help: "awx-axi ad-hoc stdout <id> [--tail <n> | --lines <a-b>]",
      flags: [
        { name: "tail", description: "tail N lines", takesValue: true },
        { name: "lines", description: "line range A-B", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "ad_hoc_stdout", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: stdoutPlan,
    },
  ],
});
