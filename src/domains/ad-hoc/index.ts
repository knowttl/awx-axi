/**
 * The `ad-hoc` domain: inspect and launch ad hoc command runs (design.md §7.2).
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, rawRegion, type Row } from "../../core/output.js";
import { pollUntilTerminal, succeeded } from "../../core/poll.js";
import {
  defineDomain,
  read,
  readPaged,
  readText,
  withExitCode,
  write,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";
import { resolveId } from "../../core/resolve.js";

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

function* launchPlan(input: SubcommandInput): Plan<DomainResult> {
  const invArg = input.args[0] ?? (typeof input.flags.inventory === "string" ? input.flags.inventory : undefined);
  if (invArg === undefined || invArg === "") {
    throw validationError("`ad-hoc launch` needs an inventory id or name via argument or --inventory", [
      "Run `awx-axi inventory list` to find an inventory",
    ]);
  }

  const inventoryId = yield* resolveId(invArg, {
    listRoute: "inventories/",
    noun: "inventory",
    listCommand: "inventory list",
    command: "ad-hoc launch",
  });

  let credentialId: number | undefined;
  if (typeof input.flags.credential === "string") {
    credentialId = yield* resolveId(input.flags.credential, {
      listRoute: "credentials/",
      noun: "credential",
      listCommand: "credential list",
      command: "ad-hoc launch",
    });
  }

  const moduleName = typeof input.flags["module-name"] === "string"
    ? input.flags["module-name"]
    : typeof input.flags.module === "string"
      ? input.flags.module
      : "command";

  const moduleArgs = typeof input.flags["module-args"] === "string"
    ? input.flags["module-args"]
    : typeof input.flags.args === "string"
      ? input.flags.args
      : "";

  const payload: Record<string, unknown> = {
    inventory: inventoryId,
    module_name: moduleName,
    module_args: moduleArgs,
  };

  if (credentialId !== undefined) payload.credential = credentialId;
  if (typeof input.flags.limit === "string") payload.limit = input.flags.limit;
  if (typeof input.flags.verbosity === "string") payload.verbosity = Number(input.flags.verbosity);
  if (typeof input.flags["extra-vars"] === "string") {
    try {
      payload.extra_vars = JSON.parse(input.flags["extra-vars"]);
    } catch {
      payload.extra_vars = input.flags["extra-vars"];
    }
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "launch",
        inventory: inventoryId,
        module_name: moduleName,
        module_args: moduleArgs,
        would_send: "POST ad_hoc_commands/",
      },
      help: ["Re-run with --confirm to launch"],
    });
  }

  const launchRes = yield* write("ad_hoc_commands/", payload, { method: "POST", tag: "operational" });
  if (launchRes.status !== 201 && launchRes.status !== 200 && launchRes.status !== 202) {
    throw errorForResponse(launchRes, { subject: "ad-hoc command" });
  }

  const resBody = (launchRes.body ?? {}) as Record<string, unknown>;
  const commandId = typeof resBody.id === "number" ? resBody.id : 0;
  const status = typeof resBody.status === "string" ? resBody.status : "pending";

  if (input.flags.wait === true && commandId > 0) {
    const timeoutSec = typeof input.flags.timeout === "string" ? Number(input.flags.timeout) : 3600;
    const pollRes = yield* pollUntilTerminal({
      route: `ad_hoc_commands/${commandId}/`,
      timeoutMs: timeoutSec * 1000,
      resumeCommand: `awx-axi ad-hoc show ${commandId}`,
    });
    return withExitCode(
      detailOutput({
        label: "ad_hoc_command",
        fields: {
          id: commandId,
          inventory: inventoryId,
          module_name: moduleName,
          status: pollRes.status,
          waited: `${Math.round(pollRes.waitedMs / 1000)}s`,
        },
        help: [`Run \`awx-axi ad-hoc stdout ${commandId}\` for command stdout`],
      }),
      succeeded(pollRes.status) ? 0 : 1,
    );
  }

  return detailOutput({
    label: "ad_hoc_command",
    fields: {
      id: commandId,
      inventory: inventoryId,
      module_name: moduleName,
      status,
    },
    help: [`Run \`awx-axi ad-hoc stdout ${commandId}\` for command stdout`],
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
    "ad-hoc: inspect and launch ad hoc commands",
    "",
    "Subcommands:",
    "  launch   [<inventory>] [--module-name <m>] [--module-args <a>] [--confirm] [--dry-run]",
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
    "launch_ad_hoc_command",
  ],
  subcommands: [
    {
      name: "launch",
      help: "awx-axi ad-hoc launch [<inventory>] [--module-name <m>] [--module-args <a>] [--confirm] [--dry-run]",
      flags: [
        { name: "inventory", description: "inventory id or name", takesValue: true },
        { name: "module-name", description: "module name (e.g. command)", takesValue: true },
        { name: "module", description: "alias for module-name", takesValue: true },
        { name: "module-args", description: "module arguments", takesValue: true },
        { name: "args", description: "alias for module-args", takesValue: true },
        { name: "credential", description: "credential id or name", takesValue: true },
        { name: "limit", description: "host limit", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON", takesValue: true },
        { name: "verbosity", description: "verbosity level 0-5", takesValue: true },
        { name: "wait", description: "wait for completion", takesValue: false },
        { name: "timeout", description: "wait timeout in seconds", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<inventory>"], required: 0 },
      schema: { label: "ad_hoc_command", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: launchPlan,
    },
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
