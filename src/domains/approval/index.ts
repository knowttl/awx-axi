/**
 * The `approval` domain: the workflow approval inbox (design.md §7.7).
 *
 * Approvals are a top-level noun rather than living under `workflow` because
 * they are the one thing in AWX waiting on a human decision, which makes them
 * an inbox. This module builds the inbox surface - `approval list`,
 * `approval show`, `approval approve`, and `approval deny`.
 */
import { AxiError } from "axi-sdk-js";

import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput } from "../../core/output.js";
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

const DEFAULT_LIST_LIMIT = 20;
const NODE_LIMIT = 200;

const LIST_SCHEMA = {
  label: "approvals",
  defaultFields: ["id", "name", "workflow", "status"],
  fieldAllowlist: [],
} as const;

type ApprovalRow = {
  readonly id: number;
  readonly name: string;
  readonly workflow: string | null;
  readonly status: string;
};

function toRow(raw: unknown): ApprovalRow {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const workflow = (summary.source_workflow_job ?? {}) as Record<
    string,
    unknown
  >;
  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    workflow: typeof workflow.name === "string" ? workflow.name : null,
    status: typeof record.status === "string" ? record.status : "",
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const all = input.flags.all === true;
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT);

  const paged = yield* readPaged(
    "workflow_approvals/",
    all ? {} : { status: "pending" },
    limit,
  );

  const rows = paged.rows.map(toRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: all ? "0 approvals found" : "0 approvals pending",
    help:
      rows.length === 0
        ? all
          ? []
          : [
              "Run `awx-axi approval list --all` to include approvals that were already decided",
            ]
        : [
            "Run `awx-axi approval show <id>` to see what an approval gates before deciding",
          ],
  });
}

interface Block {
  readonly node: number;
  readonly template: string | null;
}

function computeBlocks(rows: readonly unknown[], approvalId: number): Block[] {
  const nodes = rows.map((row) => (row ?? {}) as Record<string, unknown>);
  const byId = new Map<number, Record<string, unknown>>();
  for (const node of nodes) {
    if (typeof node.id === "number") {
      byId.set(node.id, node);
    }
  }

  const approvalNode = nodes.find((node) => node.job === approvalId);
  if (approvalNode === undefined) {
    return [];
  }

  const downstream: number[] = [];
  for (const edge of [approvalNode.success_nodes, approvalNode.always_nodes]) {
    if (!Array.isArray(edge)) {
      continue;
    }
    for (const nodeId of edge) {
      if (typeof nodeId === "number" && !downstream.includes(nodeId)) {
        downstream.push(nodeId);
      }
    }
  }

  return downstream.map((nodeId) => {
    const node = byId.get(nodeId);
    const template = (node?.summary_fields ?? {}) as Record<string, unknown>;
    const ujt = (template.unified_job_template ?? {}) as Record<
      string,
      unknown
    >;
    return {
      node: nodeId,
      template: typeof ujt.name === "string" ? ujt.name : null,
    };
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_approvals/",
    noun: "approval",
    listCommand: "approval list",
    command: "approval show",
  });

  const detail = yield* read(`workflow_approvals/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `approval ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const workflow = (summary.source_workflow_job ?? {}) as Record<
    string,
    unknown
  >;
  const workflowId =
    typeof workflow.id === "number" ? workflow.id : undefined;
  const workflowName =
    typeof workflow.name === "string" ? workflow.name : undefined;

  const blocks =
    workflowId === undefined
      ? []
      : computeBlocks(
          (yield* readPaged(
            `workflow_jobs/${workflowId}/workflow_nodes/`,
            {},
            NODE_LIMIT,
          )).rows,
          id,
        );

  return detailOutput({
    label: "approval",
    fields: {
      id,
      name: body.name ?? null,
      workflow:
        workflowId === undefined
          ? null
          : workflowName === undefined
            ? String(workflowId)
            : `${workflowId} (${workflowName})`,
      status: body.status ?? null,
      requested: body.created ?? null,
      timeout: body.timeout ?? null,
      expires: body.approval_expiration ?? null,
      blocks,
    },
    help: [
      `Run \`awx-axi approval approve ${id}\` to release the ${blocks.length} downstream step${blocks.length === 1 ? "" : "s"}`,
      `Run \`awx-axi approval deny ${id}\` to fail the workflow at this step`,
    ],
  });
}

function* approvePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_approvals/",
    noun: "approval",
    listCommand: "approval list",
    command: "approval approve",
  });

  if (input.flags["dry-run"] === true) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "approve",
        approval: id,
        would_send: `POST workflow_approvals/${id}/approve/`,
      },
      help: ["Re-run without --dry-run to approve"],
    });
  }

  const res = yield* write(`workflow_approvals/${id}/approve/`);
  if (res.status === 400 || res.status === 405) {
    const detail = yield* read(`workflow_approvals/${id}/`);
    if (detail.status === 200) {
      const body = (detail.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === "string" ? body.status : "";
      if (status === "approved") {
        return withExitCode(
          {
            approval: `${id} already approved (no-op)`,
          },
          0,
        );
      }
      if (status === "denied") {
        throw new AxiError(
          `approval ${id} was already denied and cannot be approved`,
          "ALREADY_DECIDED",
          ["Run `awx-axi approval list --all` to see decided approvals"],
        );
      }
    }
    throw errorForResponse(res, { subject: `approval ${id}` });
  }

  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `approval ${id}` });
  }

  return detailOutput({
    label: "approval",
    fields: {
      id,
      status: "approved",
    },
    help: ["Run `awx-axi approval list` to see remaining pending approvals"],
  });
}

function* denyPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_approvals/",
    noun: "approval",
    listCommand: "approval list",
    command: "approval deny",
  });

  if (input.flags["dry-run"] === true) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "deny",
        approval: id,
        would_send: `POST workflow_approvals/${id}/deny/`,
      },
      help: ["Re-run without --dry-run to deny"],
    });
  }

  const res = yield* write(`workflow_approvals/${id}/deny/`);
  if (res.status === 400 || res.status === 405) {
    const detail = yield* read(`workflow_approvals/${id}/`);
    if (detail.status === 200) {
      const body = (detail.body ?? {}) as Record<string, unknown>;
      const status = typeof body.status === "string" ? body.status : "";
      if (status === "denied") {
        return withExitCode(
          {
            approval: `${id} already denied (no-op)`,
          },
          0,
        );
      }
      if (status === "approved") {
        throw new AxiError(
          `approval ${id} was already approved and cannot be denied`,
          "ALREADY_DECIDED",
          ["Run `awx-axi approval list --all` to see decided approvals"],
        );
      }
    }
    throw errorForResponse(res, { subject: `approval ${id}` });
  }

  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `approval ${id}` });
  }

  return detailOutput({
    label: "approval",
    fields: {
      id,
      status: "denied",
    },
    help: ["Run `awx-axi approval list` to see remaining pending approvals"],
  });
}

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
): number {
  if (typeof raw !== "string") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`approval list\`, got ${raw}`,
      ["Run `awx-axi approval list --limit 20` for the 20 most recent"],
    );
  }
  return value;
}

export const approvalDomain: Domain = defineDomain({
  name: "approval",
  help: [
    "approval: the workflow approval inbox - what is waiting on a human decision",
    "",
    "Subcommands:",
    "  list      [--all] [--limit <n>]   pending approvals, or all with --all",
    "  show      <id|name>               what one approval gates before deciding",
    "  approve   <id|name>               approve a pending workflow approval",
    "  deny      <id|name>               deny a pending workflow approval",
  ].join("\n"),
  mcpEquivalents: [
    "list_pending_approvals",
    "get_approval",
    "approve_approval",
    "deny_approval",
  ],
  subcommands: [
    {
      name: "list",
      help: [
        "awx-axi approval list [--all] [--limit <n>]",
        "",
        "Lists pending workflow approvals - the inbox of decisions waiting on a human.",
        "",
        "Flags:",
        "  --all           include approvals that were already approved or denied",
        `  --limit <n>     rows to return (default ${DEFAULT_LIST_LIMIT})`,
        "",
        "Examples:",
        "  awx-axi approval list",
        "  awx-axi approval list --all --limit 50",
      ].join("\n"),
      flags: [
        {
          name: "all",
          description: "include decided approvals, not just pending",
          takesValue: false,
        },
        {
          name: "limit",
          description: "rows to return",
          takesValue: true,
        },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "pending",
          suggestions: [
            "Run `awx-axi approval show <id>` to see what an approval gates before deciding",
          ],
        },
        {
          outcome: "empty",
          suggestions: [
            "Run `awx-axi approval list --all` to include approvals that were already decided",
          ],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: [
        "awx-axi approval show <id|name>",
        "",
        "Prints what a pending approval gates: the workflow it belongs to, when it",
        "was requested, when it expires, and the downstream steps it blocks.",
        "",
        "Arguments:",
        "  <id|name>   the approval's id, or its name (resolved per §7.3)",
        "",
        "Examples:",
        "  awx-axi approval show 57",
        '  awx-axi approval show "Prod release gate"',
      ].join("\n"),
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "approval",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [
        {
          outcome: "shown",
          suggestions: [
            "Run `awx-axi approval approve <id>` to release the downstream steps",
            "Run `awx-axi approval deny <id>` to fail the workflow at this step",
          ],
        },
      ],
      plan: showPlan,
    },
    {
      name: "approve",
      help: "awx-axi approval approve <id|name> [--dry-run]",
      flags: [
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "approval", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: approvePlan,
    },
    {
      name: "deny",
      help: "awx-axi approval deny <id|name> [--dry-run]",
      flags: [
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "approval", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: denyPlan,
    },
  ],
});
