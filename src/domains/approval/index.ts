/**
 * The `approval` domain: the read-only approval inbox (design.md §7.7).
 *
 * Approvals are a top-level noun rather than living under `workflow` because
 * they are the one thing in AWX waiting on a human decision, which makes them
 * an inbox. This module builds the read surface - `approval list` and
 * `approval show` - which answers what is waiting, what it gates, and when it
 * was requested. `approve` and `deny` are a later task (§6.1).
 *
 * Per §10.2 this domain speaks no HTTP and imports no other domain: it declares
 * the reads it needs through the core's resumable plan generator, and the core
 * owns auth, pagination, error translation, and TOON encoding.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput } from "../../core/output.js";
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

/**
 * An approval inbox is a short queue, so the default covers the pending set in
 * one call the way §8.2's `job list` default does for a history scan, rather
 * than the whole-inventory 100 used for the launchable-thing lists.
 */
const DEFAULT_LIST_LIMIT = 20;

/**
 * The node graph of one workflow run is bounded, so a single generous page
 * reads it whole. `blocks` in §7.7 is derived from this list; under-reading it
 * would silently drop downstream steps.
 */
const NODE_LIMIT = 200;

const LIST_SCHEMA = {
  label: "approvals",
  // §7.7 gives no `--fields` flag for `approval list`, so the allowlist is
  // empty and the schema is fixed: id, the approval's name, the workflow it
  // gates, and its decision status (which is what `--all` makes worth showing).
  defaultFields: ["id", "name", "workflow", "status"],
  fieldAllowlist: [],
} as const;

/**
 * One approval row for the list, flattened from the API's nested shape. A type
 * alias rather than an interface so it satisfies the core's `Row` index
 * signature.
 */
type ApprovalRow = {
  readonly id: number;
  readonly name: string;
  /** The workflow run's name, from `summary_fields.source_workflow_job`. */
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

/**
 * `approval list` defaults to pending only; `--all` includes decided ones
 * (§7.7). The default filter is a `status=pending` query, dropped by `--all`.
 */
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

/** One downstream step an approval gates, for the §7.7 `blocks` block. */
interface Block {
  readonly node: number;
  readonly template: string | null;
}

/**
 * `blocks` comes from the workflow job's node list, and it is the difference
 * between an informed approval and a blind one (§7.7). The approval's own node
 * is the one whose spawned `job` is this approval; the steps it releases are
 * that node's success and always edges.
 */
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

/**
 * `approval show` prints what the step gates before anyone decides (§7.7): the
 * approval detail, then the downstream steps read from the workflow's node
 * list. Two reads for a numeric id, or three when a name is resolved first
 * (§7.3).
 */
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
    // The help lines are the whole reason `show` exists: it makes a later
    // approve or deny an informed action rather than a blind one (§7.7).
    help: [
      `Run \`awx-axi approval approve ${id}\` to release the ${blocks.length} downstream step${blocks.length === 1 ? "" : "s"}`,
      `Run \`awx-axi approval deny ${id}\` to fail the workflow at this step`,
    ],
  });
}

/**
 * Parse `--limit` to a positive integer, or reject it before any read. §9.1
 * codes a non-positive limit `VALIDATION_ERROR`, exit 2, and AXI §6 requires it
 * be caught before any dependent call.
 */
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
    "  list   [--all] [--limit <n>]   pending approvals, or all with --all",
    "  show   <id|name>               what one approval gates before deciding",
  ].join("\n"),
  // The awx-mcp tools this read surface covers, read by §14.2's coverage tool.
  mcpEquivalents: ["list_pending_approvals", "get_approval"],
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
      // A detail view has no list schema; the fixed shape lives in the plan.
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
  ],
});
