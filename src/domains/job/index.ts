/**
 * The `job` domain: the unified run surface (design.md §7.2).
 *
 * Playbook jobs, workflow jobs, project updates, inventory updates, ad hoc
 * commands, and system jobs are subclasses of unified jobs in AWX. This domain
 * exposes them under one noun: list, show, stdout, events, hosts, cancel,
 * relaunch, and watch.
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse, validationError } from "../../core/errors.js";
import {
  detailOutput,
  listOutput,
  rawRegion,
  type Row,
} from "../../core/output.js";
import {
  isActiveStatus,
  pollUntilTerminal,
  succeeded,
} from "../../core/poll.js";
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
import {
  resolveUnifiedJob,
} from "../../core/resolve.js";

const DEFAULT_LIST_LIMIT = 20;
const EVENTS_LIMIT = 50;

const VALID_STATUSES: readonly string[] = [
  "new",
  "pending",
  "waiting",
  "running",
  "successful",
  "failed",
  "error",
  "canceled",
];

const TYPE_MAP: Readonly<Record<string, { route: string; awxType: string }>> = {
  job: { route: "jobs", awxType: "job" },
  workflow: { route: "workflow_jobs", awxType: "workflow_job" },
  workflow_job: { route: "workflow_jobs", awxType: "workflow_job" },
  "project-update": { route: "project_updates", awxType: "project_update" },
  project_update: { route: "project_updates", awxType: "project_update" },
  "inventory-update": {
    route: "inventory_updates",
    awxType: "inventory_update",
  },
  inventory_update: {
    route: "inventory_updates",
    awxType: "inventory_update",
  },
  "ad-hoc": { route: "ad_hoc_commands", awxType: "ad_hoc_command" },
  ad_hoc_command: { route: "ad_hoc_commands", awxType: "ad_hoc_command" },
  system: { route: "system_jobs", awxType: "system_job" },
  system_job: { route: "system_jobs", awxType: "system_job" },
};

function resolveTypeRoute(typeFlag: string | undefined): string | undefined {
  if (typeFlag === undefined || typeFlag === "all") {
    return undefined;
  }
  const entry = TYPE_MAP[typeFlag];
  if (entry === undefined) {
    throw validationError(`unknown --type "${typeFlag}" for \`job\``, [
      `valid types for \`job\`: job, workflow, project-update, inventory-update, ad-hoc, system, all`,
    ]);
  }
  return entry.route;
}

function resolveAwxType(typeFlag: string | undefined): string | undefined {
  if (typeFlag === undefined || typeFlag === "all") {
    return undefined;
  }
  const entry = TYPE_MAP[typeFlag];
  return entry?.awxType;
}

function* resolveTypedRoute(
  id: number,
  typeFlag: string | undefined,
): Plan<{ routePrefix: string; jobType: string; name?: string }> {
  const explicitRoute = resolveTypeRoute(typeFlag);
  if (explicitRoute !== undefined) {
    const awxType = resolveAwxType(typeFlag) ?? (typeFlag ?? "job");
    return { routePrefix: explicitRoute, jobType: awxType };
  }

  const unified = yield* resolveUnifiedJob(id);
  const routePrefix = resolveTypeRoute(unified.type);
  if (routePrefix === undefined) {
    return { routePrefix: "jobs", jobType: unified.type, name: unified.name };
  }
  return { routePrefix, jobType: unified.type, name: unified.name };
}

function parseSince(since: string): string {
  const match = /^(\d+)([smhd])$/.exec(since);
  if (match !== null) {
    const value = Number(match[1]);
    const unit = match[2] as "s" | "m" | "h" | "d";
    const msMap = {
      s: 1000,
      m: 60_000,
      h: 3600_000,
      d: 86400_000,
    };
    const factor = msMap[unit];
    const ms = value * (typeof factor === "number" ? factor : 1000);
    return new Date(Date.now() - ms).toISOString();
  }
  return since;
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
      `--limit must be a positive integer for \`job ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi job ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

const LIST_SCHEMA = {
  label: "jobs",
  defaultFields: ["id", "name", "status", "finished"],
  fieldAllowlist: [
    "type",
    "launched_by",
    "template",
    "created",
    "started",
    "elapsed",
    "failed",
  ],
} as const;

function toJobRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const createdBy = (summary.created_by ?? {}) as Record<string, unknown>;
  const ujt = (summary.unified_job_template ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    type: typeof record.type === "string" ? record.type : null,
    status: typeof record.status === "string" ? record.status : "",
    finished: typeof record.finished === "string" ? record.finished : null,
    created: typeof record.created === "string" ? record.created : null,
    started: typeof record.started === "string" ? record.started : null,
    elapsed: typeof record.elapsed === "number" ? record.elapsed : null,
    failed: typeof record.failed === "boolean" ? record.failed : false,
    launched_by: typeof createdBy.username === "string" ? createdBy.username : null,
    template: typeof ujt.name === "string" ? ujt.name : null,
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  const typeFlag = typeof input.flags.type === "string" ? input.flags.type : undefined;
  if (typeFlag !== undefined && typeFlag !== "all") {
    const awxType = resolveAwxType(typeFlag);
    if (awxType === undefined) {
      throw validationError(`unknown --type "${typeFlag}" for \`job list\``, [
        "valid types for `job list`: job, workflow, project-update, inventory-update, ad-hoc, system, all",
      ]);
    }
    query.type = awxType;
  } else if (typeFlag === undefined) {
    query.type = "job";
  }

  const statusFlag = typeof input.flags.status === "string" ? input.flags.status : undefined;
  if (statusFlag !== undefined && statusFlag !== "all") {
    if (!VALID_STATUSES.includes(statusFlag)) {
      throw validationError(`unknown --status "${statusFlag}" for \`job list\``, [
        `valid statuses for \`job list\`: ${VALID_STATUSES.join(", ")}, all`,
      ]);
    }
    query.status = statusFlag;
  }

  if (input.flags.failed === true) {
    query.failed = true;
  }

  if (typeof input.flags.template === "string") {
    query.unified_job_template = input.flags.template;
  }

  if (typeof input.flags.since === "string") {
    query.finished__gte = parseSince(input.flags.since);
  }

  const paged = yield* readPaged("unified_jobs/", query, limit);
  const rows = paged.rows.map(toJobRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: statusFlag !== undefined
      ? `0 ${statusFlag} jobs found`
      : input.flags.failed === true
        ? "0 failed jobs found"
        : "0 jobs found",
    help: rows.length === 0
      ? ["Run `awx-axi job list --type all` to see runs of every kind"]
      : [
          "Run `awx-axi job show <id>` for the failure detail",
          "Run `awx-axi job stdout <id>` for the playbook output",
        ],
  });
}

function parseJobId(arg: string | undefined, command: string): number {
  if (arg === undefined || !/^\d+$/.test(arg)) {
    throw validationError(`\`job ${command}\` needs a numeric job id, got "${arg ?? ""}"`, [
      `Run \`awx-axi job list\` to find a job id`,
    ]);
  }
  return Number(arg);
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "show");
  const typeFlag = typeof input.flags.type === "string" ? input.flags.type : undefined;

  const { routePrefix, jobType } = yield* resolveTypedRoute(id, typeFlag);

  const detailRes = yield* read(`${routePrefix}/${id}/`);
  if (detailRes.status !== 200) {
    throw errorForResponse(detailRes, { subject: `job ${id}` });
  }

  const body = (detailRes.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const createdBy = (summary.created_by ?? {}) as Record<string, unknown>;
  const ujt = (summary.unified_job_template ?? {}) as Record<string, unknown>;

  const fields: Record<string, unknown> = {
    id,
    type: jobType,
    name: body.name ?? null,
    status: body.status ?? null,
    template: ujt.name !== undefined ? `${ujt.id ?? ""} (${ujt.name})` : null,
    launched_by: createdBy.username ?? null,
    started: body.started ?? null,
    elapsed: body.elapsed ?? null,
  };

  if (jobType === "job") {
    const hostSummaries = yield* readPaged(`jobs/${id}/job_host_summaries/`, {}, 200);
    const hostRows = hostSummaries.rows.map((r) => (r ?? {}) as Record<string, unknown>);
    let ok = 0;
    let failed = 0;
    let unreachable = 0;

    for (const h of hostRows) {
      if (typeof h.ok === "number") ok += h.ok;
      if (typeof h.failed === "number" && h.failed > 0) failed += 1;
      if (typeof h.unreachable === "number" && h.unreachable > 0) unreachable += 1;
    }

    fields.hosts = `${hostRows.length} total, ${ok} ok, ${failed} failed, ${unreachable} unreachable`;

    if (body.status === "failed" || body.status === "error") {
      const failedEvents = yield* readPaged(`jobs/${id}/job_events/`, { failed: true }, 50);
      const failedTasks = failedEvents.rows.map((e) => {
        const rec = (e ?? {}) as Record<string, unknown>;
        return {
          host: (rec.host_name as string) ?? null,
          task: (rec.task as string) ?? null,
        };
      });
      fields.failed_tasks = failedTasks;
    }

    const stdoutRes = yield* readText(`jobs/${id}/stdout/`, { format: "txt" });
    if (!stdoutRes.tooLarge && stdoutRes.absoluteEnd > 0) {
      fields.stdout = `${stdoutRes.absoluteEnd} lines`;
    }
  } else if (jobType === "workflow_job") {
    const nodesRes = yield* readPaged(`workflow_jobs/${id}/workflow_nodes/`, {}, 200);
    const nodeRows = nodesRes.rows.map((n) => (n ?? {}) as Record<string, unknown>);
    let successful = 0;
    let running = 0;
    let pendingApproval = 0;
    let notRun = 0;
    const blockedOn: { node: number; approval: number }[] = [];

    for (const n of nodeRows) {
      const jobSummary = (n.summary_fields ?? {}) as Record<string, unknown>;
      const jobObj = (jobSummary.job ?? {}) as Record<string, unknown>;
      const status = jobObj.status as string | undefined;
      if (status === "successful") successful += 1;
      else if (status === "running") running += 1;
      else if (status === "pending") pendingApproval += 1;
      else notRun += 1;

      if (jobObj.type === "workflow_approval" && jobObj.id !== undefined) {
        blockedOn.push({ node: (n.id as number) ?? 0, approval: jobObj.id as number });
      }
    }

    fields.nodes = `${nodeRows.length} total, ${successful} successful, ${running} running, ${pendingApproval} pending approval, ${notRun} not run`;
    if (blockedOn.length > 0) {
      fields.blocked_on = blockedOn;
    }
  }

  const help = [
    `Run \`awx-axi job stdout ${id}\` for the tail of the output`,
    `Run \`awx-axi job relaunch ${id} --failed-only\` to retry the failed host`,
  ];

  return detailOutput({
    label: "job",
    fields,
    help,
  });
}

function* stdoutPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "stdout");
  const typeFlag = typeof input.flags.type === "string" ? input.flags.type : undefined;
  const { routePrefix } = yield* resolveTypedRoute(id, typeFlag);

  const query: Record<string, string | number | boolean> = { format: "txt" };

  if (typeof input.flags.lines === "string") {
    const match = /^(\d+)-(\d+)$/.exec(input.flags.lines);
    if (match === null) {
      throw validationError(`malformed --lines range "${input.flags.lines}" for \`job stdout\``, [
        "Run `awx-axi job stdout <id> --lines 1-200` to read from the start",
      ]);
    }
    query.start_line = Number(match[1]);
    query.end_line = Number(match[2]);
  } else if (typeof input.flags.tail === "string") {
    query.tail = Number(input.flags.tail);
  }

  const textRes = yield* readText(`${routePrefix}/${id}/stdout/`, query);

  if (textRes.tooLarge) {
    const sizeMb = ((textRes.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1);
    const limitMb = ((textRes.displayLimitBytes ?? 0) / (1024 * 1024)).toFixed(1);
    throw new AxiError(
      `this job's output is ${sizeMb} MB, above the controller's ${limitMb} MB display limit`,
      "OUTPUT_TOO_LARGE",
      [
        `Run \`awx-axi job stdout ${id} --download ./${id}.log\` to fetch the whole thing`,
        `Run \`awx-axi job events ${id} --failed\` for the failing tasks only`,
      ],
    );
  }

  const header = {
    job_stdout: {
      id,
      lines: `${textRes.rangeStart}-${textRes.rangeEnd} of ${textRes.absoluteEnd}`,
    },
  };

  return rawRegion({
    header,
    label: "stdout",
    body: textRes.content,
    help: [
      `Run \`awx-axi job stdout ${id} --lines 1-200\` to read from the start`,
      `Run \`awx-axi job events ${id} --failed\` for the failing tasks only`,
    ],
  });
}

function* eventsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "events");
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

  const paged = yield* readPaged(`jobs/${id}/job_events/`, query, limit);
  const rows = paged.rows.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    return {
      id: typeof rec.id === "number" ? rec.id : 0,
      event: typeof rec.event === "string" ? rec.event : "",
      host: typeof rec.host_name === "string" ? rec.host_name : null,
      task: typeof rec.task === "string" ? rec.task : null,
      failed: typeof rec.failed === "boolean" ? rec.failed : false,
      changed: typeof rec.changed === "boolean" ? rec.changed : false,
    };
  });

  return listOutput({
    label: "events",
    rows,
    count: paged.count,
    empty: "0 events found",
    help: [
      `Run \`awx-axi job stdout ${id}\` for the full output`,
    ],
  });
}

function* hostsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "hosts");
  const paged = yield* readPaged(`jobs/${id}/job_host_summaries/`, {}, 200);

  const rows = paged.rows.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    const summary = (rec.summary_fields ?? {}) as Record<string, unknown>;
    const host = (summary.host ?? {}) as Record<string, unknown>;
    return {
      host: typeof host.name === "string" ? host.name : (rec.host_name as string) ?? "",
      ok: typeof rec.ok === "number" ? rec.ok : 0,
      changed: typeof rec.changed === "number" ? rec.changed : 0,
      failed: typeof rec.failed === "number" ? rec.failed : 0,
      unreachable: typeof rec.unreachable === "number" ? rec.unreachable : 0,
      dark: typeof rec.dark === "number" ? rec.dark : 0,
    };
  });

  return listOutput({
    label: "hosts",
    rows,
    count: paged.count,
    empty: "0 host summaries found",
  });
}

function* cancelPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "cancel");
  const typeFlag = typeof input.flags.type === "string" ? input.flags.type : undefined;
  const { routePrefix } = yield* resolveTypedRoute(id, typeFlag);

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "cancel",
        job: id,
        would_send: `POST ${routePrefix}/${id}/cancel/`,
      },
      help: ["Re-run with --confirm to cancel"],
    });
  }

  const cancelRes = yield* write(`${routePrefix}/${id}/cancel/`);

  if (cancelRes.status === 405) {
    const detailRes = yield* read(`${routePrefix}/${id}/`);
    if (detailRes.status === 200) {
      const body = (detailRes.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === "string" ? body.status : "finished";
      if (!isActiveStatus(status)) {
        return withExitCode(
          {
            job: `${id} already finished (${status}), nothing to cancel (no-op)`,
            help: [`Run \`awx-axi job relaunch ${id}\` to run it again`],
          },
          0,
        );
      }
    }
    throw errorForResponse(cancelRes, { subject: `job ${id}` });
  }

  if (cancelRes.status !== 202 && cancelRes.status !== 200) {
    throw errorForResponse(cancelRes, { subject: `job ${id}` });
  }

  const body = (cancelRes.body ?? {}) as Record<string, unknown>;
  return detailOutput({
    label: "job",
    fields: {
      id,
      name: body.name ?? null,
      status: body.status ?? "canceled",
      elapsed: body.elapsed ?? null,
    },
    help: [`Run \`awx-axi job relaunch ${id}\` to run it again`],
  });
}

function* relaunchPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "relaunch");
  const typeFlag = typeof input.flags.type === "string" ? input.flags.type : undefined;
  const { routePrefix } = yield* resolveTypedRoute(id, typeFlag);

  const failedOnly = input.flags["failed-only"] === true;
  const body = failedOnly ? { relaunch_type: "failed" } : {};

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "relaunch",
        job: id,
        failed_only: failedOnly,
        would_send: `POST ${routePrefix}/${id}/relaunch/`,
      },
      help: ["Re-run with --confirm to relaunch"],
    });
  }

  const relaunchRes = yield* write(`${routePrefix}/${id}/relaunch/`, body);
  if (relaunchRes.status !== 201 && relaunchRes.status !== 200 && relaunchRes.status !== 202) {
    throw errorForResponse(relaunchRes, { subject: `job ${id}` });
  }

  const resBody = (relaunchRes.body ?? {}) as Record<string, unknown>;
  const newId = typeof resBody.id === "number" ? resBody.id : id;

  return detailOutput({
    label: "job",
    fields: {
      id: newId,
      name: resBody.name ?? null,
      status: resBody.status ?? "pending",
    },
    help: [`Run \`awx-axi job watch ${newId}\` to follow it to completion`],
  });
}

function* watchPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = parseJobId(input.args[0], "watch");
  const typeFlag = typeof input.flags.type === "string" ? input.flags.type : undefined;
  const { routePrefix } = yield* resolveTypedRoute(id, typeFlag);

  const timeoutSec = typeof input.flags.timeout === "string" ? Number(input.flags.timeout) : 600;
  const intervalSec = typeof input.flags.interval === "string" ? Number(input.flags.interval) : 5;

  const result = yield* pollUntilTerminal({
    route: `${routePrefix}/${id}/`,
    timeoutMs: timeoutSec * 1000,
    intervalMs: intervalSec * 1000,
    resumeCommand: `awx-axi job watch ${id}`,
  });

  const body = (result.body ?? {}) as Record<string, unknown>;
  const elapsed = typeof body.elapsed === "number" ? body.elapsed : Math.round(result.waitedMs / 1000);

  const exitCode = succeeded(result.status) ? 0 : 1;
  const output = detailOutput({
    label: "job",
    fields: {
      id,
      name: body.name ?? null,
      status: result.status,
      elapsed,
      waited: `${Math.round(result.waitedMs / 1000)}s`,
    },
    help: [
      `Run \`awx-axi job stdout ${id}\` for the tail of the output`,
      `Run \`awx-axi job relaunch ${id} --failed-only\` to retry the failed host`,
    ],
  });

  return withExitCode(output, exitCode);
}

export const jobDomain: Domain = defineDomain({
  name: "job",
  help: [
    "job: inspect and manage AWX unified jobs (playbooks, workflows, syncs)",
    "",
    "Subcommands:",
    "  list     [--status <s>] [--type <t>] [--failed] [--since <time>] [--limit <n>]",
    "  show     <id> [--type <t>]",
    "  stdout   <id> [--tail <n> | --lines <a-b>] [--full] [--type <t>]",
    "  events   <id> [--failed] [--host <h>] [--task <t>] [--limit <n>]",
    "  hosts    <id>",
    "  cancel   <id> [--type <t>] [--confirm] [--dry-run]",
    "  relaunch <id> [--failed-only] [--type <t>] [--confirm] [--dry-run]",
    "  watch    <id> [--timeout <s >] [--interval <s >]",
  ].join("\n"),
  mcpEquivalents: [
    "list_jobs",
    "get_job",
    "get_job_stdout",
    "get_job_events",
    "get_job_host_summaries",
    "cancel_job",
    "relaunch_job",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi job list [--status <s>] [--type <t>] [--failed] [--since <time>] [--limit <n>]",
      flags: [
        { name: "status", description: "filter by status", takesValue: true },
        { name: "type", description: "job type (job, workflow, project-update, all)", takesValue: true },
        { name: "template", description: "filter by template", takesValue: true },
        { name: "failed", description: "filter to failed jobs", takesValue: false },
        { name: "since", description: "filter jobs since relative time (e.g. 2h)", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        { outcome: "listed", suggestions: ["Run `awx-axi job show <id>` for job detail"] },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi job show <id> [--type <t>]",
      flags: [
        { name: "type", description: "concrete job type", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [
        { outcome: "shown", suggestions: ["Run `awx-axi job stdout <id>` for stdout"] },
      ],
      plan: showPlan,
    },
    {
      name: "stdout",
      help: "awx-axi job stdout <id> [--tail <n> | --lines <a-b>] [--full] [--download <path>]",
      flags: [
        { name: "tail", description: "tail N lines", takesValue: true },
        { name: "lines", description: "line range A-B", takesValue: true },
        { name: "full", description: "full output", takesValue: false },
        { name: "download", description: "download to file", takesValue: true },
        { name: "ansi", description: "keep ANSI color codes", takesValue: false },
        { name: "type", description: "concrete job type", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "job_stdout", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: stdoutPlan,
    },
    {
      name: "events",
      help: "awx-axi job events <id> [--failed] [--host <h>] [--task <t>] [--limit <n>]",
      flags: [
        { name: "failed", description: "only failed events", takesValue: false },
        { name: "host", description: "filter by host name", takesValue: true },
        { name: "task", description: "filter by task name", takesValue: true },
        { name: "limit", description: "max events", takesValue: true },
        { name: "type", description: "concrete job type", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "events", defaultFields: ["id", "event", "host", "task", "failed"], fieldAllowlist: [] },
      suggestions: [],
      plan: eventsPlan,
    },
    {
      name: "hosts",
      help: "awx-axi job hosts <id>",
      flags: [],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "hosts", defaultFields: ["host", "ok", "changed", "failed", "unreachable"], fieldAllowlist: [] },
      suggestions: [],
      plan: hostsPlan,
    },
    {
      name: "cancel",
      help: "awx-axi job cancel <id> [--type <t>] [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
        { name: "type", description: "concrete job type", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: cancelPlan,
    },
    {
      name: "relaunch",
      help: "awx-axi job relaunch <id> [--failed-only] [--type <t>] [--confirm] [--dry-run]",
      flags: [
        { name: "failed-only", description: "retry failed hosts only", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
        { name: "type", description: "concrete job type", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: relaunchPlan,
    },
    {
      name: "watch",
      help: "awx-axi job watch <id> [--timeout <seconds>] [--interval <seconds>]",
      flags: [
        { name: "timeout", description: "timeout in seconds", takesValue: true },
        { name: "interval", description: "poll interval in seconds", takesValue: true },
        { name: "type", description: "concrete job type", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: watchPlan,
    },
  ],
});
