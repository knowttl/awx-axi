/**
 * The `workflow` domain: workflow job templates and node rollups (design.md §7.6).
 *
 * Workflow runs live under `job` (§7.2), so there is no singular/plural pair
 * like `workflow job` next to `workflow jobs`. `job show <workflow-run-id>`
 * carries the node rollup inline (§8.3), and `workflow nodes` is the escape hatch
 * for the full graph.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import {
  detailOutput,
  listOutput,
  type Row,
} from "../../core/output.js";
import { pollUntilTerminal, succeeded } from "../../core/poll.js";
import {
  defineDomain,
  read,
  readPaged,
  withExitCode,
  write,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";
import { resolveId } from "../../core/resolve.js";

const DEFAULT_LIST_LIMIT = 100;
const NODES_LIMIT = 200;

const LIST_SCHEMA = {
  label: "workflow_job_templates",
  defaultFields: ["id", "name", "last_job_run"],
  fieldAllowlist: ["description", "organization"],
} as const;

function toWorkflowRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    last_job_run:
      typeof lastJob.id === "number"
        ? `${lastJob.id} ${lastJob.status ?? ""}`
        : null,
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
      `--limit must be a positive integer for \`workflow ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi workflow ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("workflow_job_templates/", query, limit);
  const rows = paged.rows.map(toWorkflowRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 workflow job templates found",
    help: [
      "Run `awx-axi workflow show <id|name>` for template detail",
      "Run `awx-axi workflow launch <id|name>` to launch a workflow",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow show",
  });

  const detail = yield* read(`workflow_job_templates/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `workflow job template ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const org = (summary.organization ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  const fields: Record<string, unknown> = {
    id,
    name: body.name ?? null,
    organization: org.name !== undefined ? `${org.id ?? ""} (${org.name})` : null,
    last_run: lastJob.id !== undefined ? `${lastJob.id} ${lastJob.status ?? ""}` : null,
    survey: body.survey_enabled === true ? "enabled" : "disabled",
  };

  return detailOutput({
    label: "workflow",
    fields,
    help: [
      `Run \`awx-axi workflow survey ${id}\` for the survey questions`,
      `Run \`awx-axi workflow launch ${id}\` to launch`,
    ],
  });
}

function* surveyPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow survey",
  });

  const surveyRes = yield* read(`workflow_job_templates/${id}/survey_spec/`);
  if (surveyRes.status !== 200) {
    throw errorForResponse(surveyRes, { subject: `workflow job template ${id} survey` });
  }

  const body = (surveyRes.body ?? {}) as Record<string, unknown>;
  const spec = (body.spec ?? []) as readonly Record<string, unknown>[];

  const questions = spec.map((q) => ({
    variable: q.variable ?? "",
    question: q.question_name ?? "",
    type: q.type ?? "",
    required: q.required ?? false,
    default: q.default ?? null,
  }));

  return detailOutput({
    label: "survey",
    fields: {
      workflow: id,
      name: body.name ?? null,
      description: body.description ?? null,
      questions,
    },
    help: [
      `Run \`awx-axi workflow launch ${id} --extra-vars '{"var": "val"}'\` to launch with survey responses`,
    ],
  });
}

function parseExtraVars(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fail
  }
  throw validationError("--extra-vars is neither valid JSON nor valid YAML", [
    `Provide extra vars as a JSON object string, e.g. --extra-vars '{"env":"prod"}'`,
  ]);
}

function* launchPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow launch",
  });

  const preflightRes = yield* read(`workflow_job_templates/${id}/launch/`);
  if (preflightRes.status !== 200) {
    throw errorForResponse(preflightRes, { subject: `workflow template ${id} launch preflight` });
  }

  const extraVarsObj = parseExtraVars(
    typeof input.flags["extra-vars"] === "string" ? input.flags["extra-vars"] : undefined,
  );

  const launchBody: Record<string, unknown> = {};
  if (typeof input.flags["extra-vars"] === "string") launchBody.extra_vars = JSON.stringify(extraVarsObj);
  if (typeof input.flags.limit === "string") launchBody.limit = input.flags.limit;
  if (typeof input.flags["scm-branch"] === "string") launchBody.scm_branch = input.flags["scm-branch"];

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "launch",
        workflow: id,
        would_send: `POST workflow_job_templates/${id}/launch/`,
      },
      help: ["Re-run with --confirm to launch"],
    });
  }

  const launchRes = yield* write(`workflow_job_templates/${id}/launch/`, launchBody);
  if (launchRes.status !== 201 && launchRes.status !== 200 && launchRes.status !== 202) {
    throw errorForResponse(launchRes, {
      subject: `workflow template ${id}`,
      codes: { 400: "LAUNCH_REJECTED" },
    });
  }

  const resBody = (launchRes.body ?? {}) as Record<string, unknown>;
  const jobId = typeof resBody.id === "number" ? resBody.id : 0;
  const status = typeof resBody.status === "string" ? resBody.status : "pending";

  if (input.flags.wait === true && jobId > 0) {
    const timeoutSec = typeof input.flags.timeout === "string" ? Number(input.flags.timeout) : 600;
    const pollRes = yield* pollUntilTerminal({
      route: `workflow_jobs/${jobId}/`,
      timeoutMs: timeoutSec * 1000,
      resumeCommand: `awx-axi job watch ${jobId}`,
    });
    return withExitCode(
      detailOutput({
        label: "job",
        fields: {
          id: jobId,
          workflow: id,
          status: pollRes.status,
          waited: `${Math.round(pollRes.waitedMs / 1000)}s`,
        },
        help: [
          `Run \`awx-axi job show ${jobId}\` for job detail`,
          `Run \`awx-axi workflow nodes ${jobId}\` for node graph`,
        ],
      }),
      succeeded(pollRes.status) ? 0 : 1,
    );
  }

  return detailOutput({
    label: "job",
    fields: {
      id: jobId,
      workflow: id,
      status,
    },
    help: [
      `Run \`awx-axi job watch ${jobId}\` to follow it to completion`,
      `Run \`awx-axi workflow nodes ${jobId}\` for the full node graph`,
    ],
  });
}

function* nodesPlan(input: SubcommandInput): Plan<DomainResult> {
  const runIdArg = input.args[0] ?? "";
  const runId = yield* resolveId(runIdArg, {
    listRoute: "workflow_jobs/",
    noun: "workflow job run",
    listCommand: "job list --type workflow",
    command: "workflow nodes",
  });

  const paged = yield* readPaged(`workflow_jobs/${runId}/workflow_nodes/`, {}, NODES_LIMIT);
  const rows = paged.rows.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    const summary = (rec.summary_fields ?? {}) as Record<string, unknown>;
    const ujt = (summary.unified_job_template ?? {}) as Record<string, unknown>;
    const jobObj = (summary.job ?? {}) as Record<string, unknown>;

    return {
      id: typeof rec.id === "number" ? rec.id : 0,
      template: typeof ujt.name === "string" ? ujt.name : null,
      job: typeof jobObj.id === "number" ? jobObj.id : null,
      status: typeof jobObj.status === "string" ? jobObj.status : null,
      success_nodes: Array.isArray(rec.success_nodes) ? rec.success_nodes.join(",") : null,
      failure_nodes: Array.isArray(rec.failure_nodes) ? rec.failure_nodes.join(",") : null,
      always_nodes: Array.isArray(rec.always_nodes) ? rec.always_nodes.join(",") : null,
    };
  });

  return listOutput({
    label: "nodes",
    rows,
    count: paged.count,
    empty: "0 workflow nodes found",
    help: [
      `Run \`awx-axi job show ${runId}\` for workflow run detail`,
    ],
  });
}

function* createWorkflowPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name === "") {
    throw validationError("`workflow create` needs a workflow name argument or --name", [
      "Provide a name, e.g. `awx-axi workflow create \"Release Workflow\"`",
    ]);
  }

  const payload: Record<string, unknown> = { name };

  if (typeof input.flags.organization === "string") {
    payload.organization = yield* resolveId(input.flags.organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "workflow create",
    });
  }

  if (typeof input.flags.description === "string") payload.description = input.flags.description;
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
        action: "create",
        type: "workflow_job_template",
        name,
        would_send: "POST workflow_job_templates/",
        payload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("workflow_job_templates/", payload, { method: "POST", tag: "config" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `workflow ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "workflow",
    fields: {
      id,
      name: body.name ?? name,
    },
    help: [`Run \`awx-axi workflow show ${id}\` to inspect workflow`],
  });
}

function* editWorkflowPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.organization === "string") {
    payload.organization = yield* resolveId(input.flags.organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "workflow edit",
    });
  }
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
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
        action: "edit",
        workflow: id,
        would_send: `PATCH workflow_job_templates/${id}/`,
        payload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`workflow_job_templates/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `workflow ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "workflow",
    fields: {
      id,
      name: body.name ?? null,
    },
    help: [`Run \`awx-axi workflow show ${id}\` to inspect updated workflow`],
  });
}

export const workflowDomain: Domain = defineDomain({
  name: "workflow",
  help: [
    "workflow: workflow job templates and node rollups",
    "",
    "Subcommands:",
    "  create   [<name>] [--organization <o>] [--confirm] [--dry-run]",
    "  edit     <id|name> [--name <n>] [--confirm] [--dry-run]",
    "  list     [--search <s>] [--limit <n>]",
    "  show     <id|name>",
    "  survey   <id|name>",
    "  launch   <id|name> [--extra-vars '<json>'] [--wait] [--confirm] [--dry-run]",
    "  nodes    <run-id>",
  ].join("\n"),
  mcpEquivalents: [
    "list_workflow_job_templates",
    "get_workflow_job_template",
    "get_workflow_job_template_survey",
    "launch_workflow_job_template",
    "get_workflow_job_nodes",
    "create_workflow_job_template",
    "update_workflow_job_template",
  ],
  subcommands: [
    {
      name: "create",
      help: "awx-axi workflow create [<name>] [--organization <o>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "workflow template name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "workflow", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createWorkflowPlan,
    },
    {
      name: "edit",
      help: "awx-axi workflow edit <id|name> [--name <n>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "workflow template name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "workflow", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editWorkflowPlan,
    },
    {
      name: "list",
      help: "awx-axi workflow list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search workflow templates", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        { outcome: "listed", suggestions: ["Run `awx-axi workflow show <id|name>` for detail"] },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi workflow show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "workflow", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "survey",
      help: "awx-axi workflow survey <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "survey", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: surveyPlan,
    },
    {
      name: "launch",
      help: "awx-axi workflow launch <id|name> [--extra-vars '<json>'] [--wait] [--confirm] [--dry-run]",
      flags: [
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "limit", description: "host limit override", takesValue: true },
        { name: "scm-branch", description: "SCM branch override", takesValue: true },
        { name: "wait", description: "wait for completion", takesValue: false },
        { name: "timeout", description: "wait timeout in seconds", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: launchPlan,
    },
    {
      name: "nodes",
      help: "awx-axi workflow nodes <run-id>",
      flags: [],
      positionals: { names: ["<run-id>"], required: 1 },
      schema: { label: "nodes", defaultFields: ["id", "template", "job", "status"], fieldAllowlist: [] },
      suggestions: [],
      plan: nodesPlan,
    },
  ],
});
