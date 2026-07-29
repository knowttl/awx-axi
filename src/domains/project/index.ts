/**
 * The `project` domain: projects and SCM syncs (design.md §7.8).
 *
 * The verb is `sync`, not `update`, so it cannot be read as "modify the project record".
 * A sync's log is `job stdout <sync-id>`, and its progress is `job watch <sync-id>`.
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse, validationError } from "../../core/errors.js";
import {
  detailOutput,
  listOutput,
  type Row,
} from "../../core/output.js";
import { isActiveStatus, pollUntilTerminal, succeeded } from "../../core/poll.js";
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
const UPDATES_LIMIT = 20;

const LIST_SCHEMA = {
  label: "projects",
  defaultFields: ["id", "name", "scm_type", "status", "last_job_run"],
  fieldAllowlist: ["scm_url", "scm_branch", "organization"],
} as const;

function toProjectRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    scm_type: typeof record.scm_type === "string" ? record.scm_type : null,
    status: typeof record.status === "string" ? record.status : "",
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
      `--limit must be a positive integer for \`project ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi project ${subcommand} --limit ${fallback}\``],
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

  const paged = yield* readPaged("projects/", query, limit);
  const rows = paged.rows.map(toProjectRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 projects found",
    help: [
      "Run `awx-axi project show <id|name>` for project detail",
      "Run `awx-axi project sync <id|name>` to trigger an SCM sync",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "projects/",
    noun: "project",
    listCommand: "project list",
    command: "project show",
  });

  const detail = yield* read(`projects/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `project ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  const fields: Record<string, unknown> = {
    id,
    name: body.name ?? null,
    scm_type: body.scm_type ?? null,
    scm_url: body.scm_url ?? null,
    scm_branch: body.scm_branch ?? null,
    status: body.status ?? null,
    last_job_run: lastJob.id !== undefined ? `${lastJob.id} ${lastJob.status ?? ""}` : null,
  };

  return detailOutput({
    label: "project",
    fields,
    help: [
      `Run \`awx-axi project playbooks ${id}\` to list playbooks`,
      `Run \`awx-axi project sync ${id}\` to sync SCM`,
    ],
  });
}

function* playbooksPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "projects/",
    noun: "project",
    listCommand: "project list",
    command: "project playbooks",
  });

  const res = yield* read(`projects/${id}/playbooks/`);
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `project ${id} playbooks` });
  }

  const list = Array.isArray(res.body) ? res.body : [];
  const rows = list.map((item, index) => ({
    index: index + 1,
    playbook: String(item),
  }));

  return listOutput({
    label: "playbooks",
    rows,
    count: rows.length,
    empty: "0 playbooks found",
    help: [
      `Run \`awx-axi template list --project ${id}\` for templates using this project`,
    ],
  });
}

function* updatesPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "projects/",
    noun: "project",
    listCommand: "project list",
    command: "project updates",
  });

  const limit = positiveLimit(input.flags.limit, UPDATES_LIMIT, "updates");
  const paged = yield* readPaged(`projects/${id}/project_updates/`, {}, limit);

  const rows = paged.rows.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    return {
      id: typeof rec.id === "number" ? rec.id : 0,
      name: typeof rec.name === "string" ? rec.name : "",
      status: typeof rec.status === "string" ? rec.status : "",
      finished: typeof rec.finished === "string" ? rec.finished : null,
    };
  });

  return listOutput({
    label: "updates",
    rows,
    count: paged.count,
    empty: "0 project syncs found",
    help: [
      `Run \`awx-axi job stdout <id>\` for a sync log`,
    ],
  });
}

function* syncPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "projects/",
    noun: "project",
    listCommand: "project list",
    command: "project sync",
  });

  if (input.flags["dry-run"] === true) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "sync",
        project: id,
        would_send: `POST projects/${id}/update/`,
      },
      help: ["Re-run without --dry-run to sync"],
    });
  }

  const syncRes = yield* write(`projects/${id}/update/`);

  if (syncRes.status === 405) {
    const detailRes = yield* read(`projects/${id}/`);
    if (detailRes.status === 200) {
      const body = (detailRes.body ?? {}) as Record<string, unknown>;
      const scmType = body.scm_type as string | undefined | null;

      if (scmType === undefined || scmType === null || scmType === "" || scmType === "manual") {
        throw new AxiError(
          "this project has no SCM source to sync from",
          "SYNC_UNAVAILABLE",
          ["Configure an SCM source for this project in AWX before syncing"],
        );
      }

      const status = typeof body.status === "string" ? body.status : "";
      const currentUpdate = (body.current_update ?? {}) as Record<string, unknown>;
      const updateId = typeof currentUpdate.id === "number" ? currentUpdate.id : id;

      if (isActiveStatus(status) || currentUpdate.id !== undefined) {
        return withExitCode(
          {
            project: `sync already running for project ${id} (job ${updateId})`,
            help: [`Run \`awx-axi job watch ${updateId}\` to follow it`],
          },
          0,
        );
      }
    }
    throw errorForResponse(syncRes, { subject: `project ${id}` });
  }

  if (syncRes.status !== 202 && syncRes.status !== 200) {
    throw errorForResponse(syncRes, { subject: `project ${id}` });
  }

  const resBody = (syncRes.body ?? {}) as Record<string, unknown>;
  const jobId = typeof resBody.id === "number" ? resBody.id : 0;
  const status = typeof resBody.status === "string" ? resBody.status : "pending";

  if (input.flags.wait === true && jobId > 0) {
    const timeoutSec = typeof input.flags.timeout === "string" ? Number(input.flags.timeout) : 600;
    const pollRes = yield* pollUntilTerminal({
      route: `project_updates/${jobId}/`,
      timeoutMs: timeoutSec * 1000,
      resumeCommand: `awx-axi job watch ${jobId}`,
    });
    return withExitCode(
      detailOutput({
        label: "job",
        fields: {
          id: jobId,
          project: id,
          status: pollRes.status,
          waited: `${Math.round(pollRes.waitedMs / 1000)}s`,
        },
        help: [`Run \`awx-axi job stdout ${jobId}\` for the sync log`],
      }),
      succeeded(pollRes.status) ? 0 : 1,
    );
  }

  return detailOutput({
    label: "job",
    fields: {
      id: jobId,
      project: id,
      status,
    },
    help: [
      `Run \`awx-axi job watch ${jobId}\` to follow it to completion`,
      `Run \`awx-axi job stdout ${jobId}\` for the sync log`,
    ],
  });
}

export const projectDomain: Domain = defineDomain({
  name: "project",
  help: [
    "project: projects and SCM syncs",
    "",
    "Subcommands:",
    "  list        [--search <s>] [--limit <n>]",
    "  show        <id|name>",
    "  playbooks   <id|name>",
    "  updates     <id|name> [--limit <n>]",
    "  sync        <id|name> [--wait] [--dry-run]",
  ].join("\n"),
  mcpEquivalents: [
    "list_projects",
    "get_project",
    "get_project_playbooks",
    "list_project_updates",
    "sync_project",
  ],
  subcommands: [
    {
      name: "list",
      help: "awx-axi project list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search projects", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        { outcome: "listed", suggestions: ["Run `awx-axi project show <id|name>` for detail"] },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi project show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "project", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "playbooks",
      help: "awx-axi project playbooks <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "playbooks", defaultFields: ["index", "playbook"], fieldAllowlist: [] },
      suggestions: [],
      plan: playbooksPlan,
    },
    {
      name: "updates",
      help: "awx-axi project updates <id|name> [--limit <n>]",
      flags: [
        { name: "limit", description: "rows to return", takesValue: true },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "updates", defaultFields: ["id", "name", "status", "finished"], fieldAllowlist: [] },
      suggestions: [],
      plan: updatesPlan,
    },
    {
      name: "sync",
      help: "awx-axi project sync <id|name> [--wait] [--dry-run]",
      flags: [
        { name: "wait", description: "wait for completion", takesValue: false },
        { name: "timeout", description: "wait timeout in seconds", takesValue: true },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: syncPlan,
    },
  ],
});
