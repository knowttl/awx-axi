/**
 * The `workflow` domain: workflow job templates, template-node topology, and run node rollups (design.md §7.6).
 *
 * Workflow runs live under `job` (§7.2), so there is no singular/plural pair
 * like `workflow job` next to `workflow jobs`. `job show <workflow-run-id>`
 * carries the node rollup inline (§8.3), and `workflow nodes` is the escape hatch
 * for the full graph.
 */
import { parse as parseYaml } from "yaml";

import { errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive, parseInteger } from "../../core/mutations.js";
import { parseExtraVars } from "../template/index.js";
import {
  detailOutput,
  listOutput,
  type Row,
} from "../../core/output.js";
import {
  REDACTION,
  isSensitiveKey,
  redact,
  redactValue,
} from "../../core/redact.js";
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
const PROMPT_MAX_DEPTH = 8;
const PROMPT_MAX_ITEMS = 100;
const PROMPT_MAX_KEY_LENGTH = 100;
const PROMPT_MAX_STRING_LENGTH = 1000;

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

function toRoleRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    description: typeof record.description === "string" ? record.description : "",
    type: typeof record.type === "string" ? record.type : "",
  };
}

function* objectRolesPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow object-roles",
  });
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "object-roles");
  const paged = yield* readPaged(`workflow_job_templates/${id}/object_roles/`, {}, limit);
  return listOutput({
    label: "object_roles",
    rows: paged.rows.map(toRoleRow),
    count: paged.count,
    empty: "0 object roles found for workflow",
    help: [`Run \`awx-axi role show <id|name>\` to inspect role detail`],
  });
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

function workflowNodeId(raw: string, argument = "workflow node id"): number {
  return parseInteger(raw, argument, 1);
}

function nodePayload(input: SubcommandInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.template === "string") payload.unified_job_template = input.flags.template;
  if (typeof input.flags["extra-vars"] === "string") payload.extra_data = parseExtraVars(input.flags["extra-vars"]);
  if (typeof input.flags.limit === "string") payload.limit = input.flags.limit;
  if (typeof input.flags["scm-branch"] === "string") payload.scm_branch = input.flags["scm-branch"];
  if (typeof input.flags["job-type"] === "string") payload.job_type = input.flags["job-type"];
  if (typeof input.flags["job-tags"] === "string") payload.job_tags = input.flags["job-tags"];
  if (typeof input.flags["skip-tags"] === "string") payload.skip_tags = input.flags["skip-tags"];
  if (typeof input.flags.verbosity === "string") payload.verbosity = parseInteger(input.flags.verbosity, "--verbosity", 0, 5);
  if (typeof input.flags.inventory === "string") payload.inventory = input.flags.inventory;
  return payload;
}

function* createNodePlan(input: SubcommandInput): Plan<DomainResult> {
  const workflow = yield* resolveId(input.args[0] ?? "", { listRoute: "workflow_job_templates/", noun: "workflow job template", listCommand: "workflow list", command: "workflow node-create" });
  const payload = nodePayload(input);
  if (typeof payload.unified_job_template !== "string") throw validationError("`workflow node-create` needs --template id or name");
  payload.unified_job_template = yield* resolveId(payload.unified_job_template, { listRoute: "unified_job_templates/", noun: "unified job template", listCommand: "template list", command: "workflow node-create" });
  if (typeof payload.inventory === "string") payload.inventory = yield* resolveId(payload.inventory, { listRoute: "inventories/", noun: "inventory", listCommand: "inventory list", command: "workflow node-create" });
  if (!isLive(input.flags)) return dryRun("create", "workflow_node", { workflow }, `POST workflow_job_templates/${workflow}/workflow_nodes/`, payload);
  const response = yield* write(`workflow_job_templates/${workflow}/workflow_nodes/`, payload, { method: "POST", tag: "config" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `workflow ${workflow} node` });
  const body = (response.body ?? {}) as Record<string, unknown>; const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "workflow_node", fields: { id, workflow, unified_job_template: body.unified_job_template ?? payload.unified_job_template }, help: [`Run \`awx-axi workflow node-edit ${id}\` to inspect node`] });
}

function* editNodePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = workflowNodeId(input.args[0] ?? "");
  const payload = nodePayload(input);
  if (typeof payload.unified_job_template === "string") payload.unified_job_template = yield* resolveId(payload.unified_job_template, { listRoute: "unified_job_templates/", noun: "unified job template", listCommand: "template list", command: "workflow node-edit" });
  if (typeof payload.inventory === "string") payload.inventory = yield* resolveId(payload.inventory, { listRoute: "inventories/", noun: "inventory", listCommand: "inventory list", command: "workflow node-edit" });
  if (!isLive(input.flags)) return dryRun("edit", "workflow_node", { node: id }, `PATCH workflow_job_template_nodes/${id}/`, payload);
  const response = yield* write(`workflow_job_template_nodes/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (response.status !== 200) throw errorForResponse(response, { subject: `workflow node ${id}` });
  return detailOutput({ label: "workflow_node", fields: { id, status: "updated" }, help: [`Run \`awx-axi workflow nodes <workflow-run-id>\` for run nodes`] });
}

function* deleteNodePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = workflowNodeId(input.args[0] ?? "");
  if (!isLive(input.flags)) return dryRun("delete", "workflow_node", { node: id }, `DELETE workflow_job_template_nodes/${id}/`);
  const response = yield* write(`workflow_job_template_nodes/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (response.status !== 204 && response.status !== 200 && response.status !== 202) throw errorForResponse(response, { subject: `workflow node ${id}` });
  return detailOutput({ label: "workflow_node", fields: { id, status: "deleted" } });
}

function* linkNodePlan(input: SubcommandInput, remove = false): Plan<DomainResult> {
  const node = workflowNodeId(input.args[0] ?? "");
  const targetRaw = input.flags.to; if (typeof targetRaw !== "string") throw validationError("`workflow node-link` needs --to node id");
  const target = workflowNodeId(targetRaw, "--to");
  const edge = input.flags.on; if (typeof edge !== "string" || !["success", "failure", "always"].includes(edge)) throw validationError("--on must be success, failure, or always");
  const path = `workflow_job_template_nodes/${node}/${edge}_nodes/`; const payload = remove ? { id: target, disassociate: true } : { id: target };
  if (!isLive(input.flags)) return dryRun(remove ? "unlink" : "link", "workflow_node", { node, target, on: edge }, `POST ${path}`, payload);
  const response = yield* write(path, payload, { method: "POST", tag: "config" });
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `workflow node ${node}` });
  return detailOutput({ label: "workflow_edge", fields: { node, target, on: edge, status: remove ? "unlinked" : "linked" } });
}

function nodeAssociationPlan(kind: "credential" | "label" | "instance-group", remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const node = workflowNodeId(input.args[0] ?? "");
    const flag = kind; if (typeof input.flags[flag] !== "string") throw validationError(`node association needs --${flag}`);
    const routes = { credential: ["credentials", "credentials/", "credential"], label: ["labels", "labels/", "label"], "instance-group": ["instance_groups", "instance_groups/", "instance group"] } as const;
    const [route, listRoute, noun] = routes[kind];
    const target = kind === "credential"
      ? yield* resolveId(input.flags[flag], { listRoute, noun, listCommand: "credential list", command: "workflow node association" })
      : parseInteger(input.flags[flag], `--${flag}`, 1);
    const path = `workflow_job_template_nodes/${node}/${route}/`; const payload = remove ? { id: target, disassociate: true } : { id: target };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", noun, { node, [flag]: target }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: kind === "credential" ? "security" : "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `workflow node ${node}` });
    return detailOutput({ label: "workflow_node_association", fields: { node, [flag]: target, status: remove ? "removed" : "added" } });
  };
}

function* approvalNodePlan(input: SubcommandInput): Plan<DomainResult> {
  const node = workflowNodeId(input.args[0] ?? "");
  if (typeof input.flags.name !== "string") throw validationError("`workflow node-add-approval` needs --name");
  const payload: Record<string, unknown> = { name: input.flags.name };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags.timeout === "string") payload.timeout = parseInteger(input.flags.timeout, "--timeout", 0);
  if (!isLive(input.flags)) return dryRun("add-approval", "workflow_node", { node }, `POST workflow_job_template_nodes/${node}/create_approval_template/`, payload);
  const response = yield* write(`workflow_job_template_nodes/${node}/create_approval_template/`, payload, { method: "POST", tag: "config" });
  if (response.status !== 200 && response.status !== 201) throw errorForResponse(response, { subject: `workflow node ${node} approval` });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return detailOutput({ label: "approval_template", fields: { node, id: body.id ?? null, name: body.name ?? input.flags.name }, help: [`Run \`awx-axi workflow show <id|name>\` to inspect workflow`] });
}

function workflowLabelPlan(remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const workflow = yield* resolveId(input.args[0] ?? "", {
      listRoute: "workflow_job_templates/",
      noun: "workflow job template",
      listCommand: "workflow list",
      command: `workflow label-${remove ? "remove" : "add"}`,
    });
    if (typeof input.flags.label !== "string") {
      throw validationError(`\`workflow label-${remove ? "remove" : "add"}\` needs --label id`);
    }
    const label = parseInteger(input.flags.label, "--label", 1);
    const payload = remove ? { id: label, disassociate: true } : { id: label };
    const route = `workflow_job_templates/${workflow}/labels/`;
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", "label", { workflow, label }, `POST ${route}`, payload);
    const response = yield* write(route, payload, { method: "POST", tag: "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw errorForResponse(response, { subject: `workflow ${workflow} label` });
    }
    return detailOutput({ label: "workflow_label", fields: { workflow, label, status: remove ? "removed" : "added" } });
  };
}

function* copyWorkflowPlan(input: SubcommandInput): Plan<DomainResult> {
  const workflow = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow copy",
  });
  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (!isLive(input.flags)) return dryRun("copy", "workflow_job_template", { workflow }, `POST workflow_job_templates/${workflow}/copy/`, payload);
  const response = yield* write(`workflow_job_templates/${workflow}/copy/`, payload, { method: "POST", tag: "config" });
  if (response.status !== 200 && response.status !== 201) {
    throw errorForResponse(response, { subject: `workflow ${workflow}` });
  }
  const body = (response.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;
  return detailOutput({
    label: "workflow",
    fields: { id, name: body.name ?? null },
    help: [`Run \`awx-axi workflow show ${id}\` to inspect copied workflow`],
  });
}

function notificationAssociationPlan(remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const workflow = yield* resolveId(input.args[0] ?? "", { listRoute: "workflow_job_templates/", noun: "workflow job template", listCommand: "workflow list", command: `workflow notification-${remove ? "remove" : "add"}` });
    const event = input.flags.event; if (typeof event !== "string" || !["started", "success", "error", "approval"].includes(event)) throw validationError("--event must be started, success, error, or approval");
    if (typeof input.flags["notification-template"] !== "string") throw validationError("notification association needs --notification-template");
    const template = yield* resolveId(input.flags["notification-template"], { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "workflow notification" });
    const path = `workflow_job_templates/${workflow}/notification_templates_${event === "approval" ? "approvals" : event}/`; const payload = remove ? { id: template, disassociate: true } : { id: template };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", "notification_template", { workflow, notification_template: template, event }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `workflow ${workflow} notifications` });
    return detailOutput({ label: "workflow_notification", fields: { workflow, notification_template: template, event, status: remove ? "removed" : "added" } });
  };
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

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function formatReference(id: number | null, name: string | null): string | null {
  if (id === null && name === null) {
    return null;
  }
  if (id === null) {
    return name;
  }
  return name === null ? String(id) : `${id} (${name})`;
}

function relationReference(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  const relation = record(value);
  return formatReference(
    numberOrNull(relation.id),
    stringOrNull(relation.name),
  );
}

function toCredentialContext(raw: unknown): RecordValue {
  const credential = record(raw);
  const summary = record(credential.summary_fields);
  return {
    id: numberOrNull(credential.id),
    name: stringOrNull(credential.name),
    organization: relationReference(summary.organization ?? credential.organization),
    credential_type: relationReference(
      summary.credential_type ?? credential.credential_type,
    ),
    kind: stringOrNull(credential.kind),
    managed: booleanOrNull(credential.managed),
  };
}

function unifiedJobTemplate(
  node: RecordValue,
  summary: RecordValue,
): RecordValue {
  return record(summary.unified_job_template ?? node.unified_job_template);
}

function unifiedJobType(node: RecordValue, summary: RecordValue): string | null {
  return stringOrNull(unifiedJobTemplate(node, summary).unified_job_type);
}

function isApprovalNode(node: RecordValue, summary: RecordValue): boolean {
  const type = unifiedJobType(node, summary);
  return type === "workflow_approval_template" || type === "workflow_approval";
}

function approvalDetails(node: RecordValue, summary: RecordValue): RecordValue | null {
  if (!isApprovalNode(node, summary)) {
    return null;
  }
  const ujt = unifiedJobTemplate(node, summary);
  return {
    id: numberOrNull(ujt.id) ?? numberOrNull(node.unified_job_template),
    name: stringOrNull(ujt.name),
    description: stringOrNull(ujt.description),
    timeout: numberOrNull(ujt.timeout),
  };
}

function safePromptValue(
  value: unknown,
  state = { remaining: PROMPT_MAX_ITEMS },
  depth = 0,
): unknown {
  if (typeof value === "string") {
    const safe = redact(value);
    return safe.length <= PROMPT_MAX_STRING_LENGTH
      ? safe
      : `${safe.slice(0, PROMPT_MAX_STRING_LENGTH)}... (truncated, ${safe.length} chars total)`;
  }
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth >= PROMPT_MAX_DEPTH) {
    return { __awx_axi_omitted__: { reason: "depth_limit" } };
  }

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.remaining === 0) {
        output.push({
          __awx_axi_omitted__: {
            reason: "item_limit",
            count: value.length - index,
          },
        });
        break;
      }
      state.remaining -= 1;
      output.push(safePromptValue(value[index], state, depth + 1));
    }
    return output;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: RecordValue = {};
  for (let index = 0; index < entries.length; index += 1) {
    if (state.remaining === 0) {
      output.__awx_axi_omitted__ = {
        reason: "item_limit",
        count: entries.length - index,
      };
      break;
    }
    state.remaining -= 1;
    const [key, child] = entries[index] as [string, unknown];
    const boundedKey = key.length <= PROMPT_MAX_KEY_LENGTH
      ? key
      : `${key.slice(0, PROMPT_MAX_KEY_LENGTH)}... (truncated, ${key.length} chars total, item ${index})`;
    output[boundedKey] = isSensitiveKey(key)
      ? REDACTION
      : safePromptValue(child, state, depth + 1);
  }
  return output;
}

function isSafelyRepresentablePromptValue(value: unknown): boolean {
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit: boolean }> = [
    { value, exit: false },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        return false;
      }
      continue;
    }
    if (typeof item !== "object") {
      return false;
    }
    if (current.exit) {
      active.delete(item);
      complete.add(item);
      continue;
    }
    if (active.has(item)) {
      return false;
    }
    if (complete.has(item)) {
      continue;
    }

    const prototype = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== null &&
      prototype !== Object.prototype
    ) {
      return false;
    }
    active.add(item);
    stack.push({ value: item, exit: true });

    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], exit: false });
      }
      continue;
    }

    const entries = Object.entries(item as RecordValue);
    if (
      entries.some(([key]) =>
        key === "__proto__" || key === "constructor" || key === "prototype"
      )
    ) {
      return false;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push({ value: entries[index]?.[1], exit: false });
    }
  }

  return true;
}

function parseSafePromptValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return safePromptValue(value);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    try {
      parsed = parseYaml(value) as unknown;
    } catch {
      return REDACTION;
    }
  }

  return isSafelyRepresentablePromptValue(parsed)
    ? safePromptValue(parsed)
    : REDACTION;
}

function safePromptString(value: unknown): string | null {
  return typeof value === "string" ? safePromptValue(value) as string : null;
}

function promptFields(node: RecordValue): RecordValue {
  return {
    extra_data: parseSafePromptValue(node.extra_data),
    survey_passwords: parseSafePromptValue(node.survey_passwords),
    char_prompts: parseSafePromptValue(node.char_prompts),
    limit: safePromptString(node.limit),
    scm_branch: safePromptString(node.scm_branch),
    job_type: safePromptString(node.job_type),
    job_tags: safePromptString(node.job_tags),
    skip_tags: safePromptString(node.skip_tags),
    diff_mode: booleanOrNull(node.diff_mode),
    verbosity: numberOrNull(node.verbosity),
    forks: numberOrNull(node.forks),
    job_slice_count: numberOrNull(node.job_slice_count),
    timeout: numberOrNull(node.timeout),
  };
}

function edgeIds(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.filter((id): id is number => typeof id === "number");
  return ids.length > 0 ? ids.join(",") : null;
}

function promptFieldNames(node: RecordValue): string | null {
  const names: string[] = [];
  for (const field of ["extra_data", "survey_passwords", "char_prompts"]) {
    const value = node[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "object" || Object.keys(record(value)).length > 0)
    ) {
      names.push(field);
    }
  }
  for (const field of [
    "limit",
    "scm_branch",
    "job_type",
    "job_tags",
    "skip_tags",
    "diff_mode",
    "verbosity",
    "forks",
    "job_slice_count",
    "timeout",
  ]) {
    if (node[field] !== undefined && node[field] !== null) {
      names.push(field);
    }
  }
  return names.length > 0 ? names.join(",") : null;
}

function toTemplateNodeRow(raw: unknown): Row {
  const node = record(raw);
  const summary = record(node.summary_fields);
  const ujt = unifiedJobTemplate(node, summary);
  const type = unifiedJobType(node, summary);

  return {
    id: numberOrNull(node.id) ?? 0,
    identifier: stringOrNull(node.identifier),
    unified_job_type: type,
    unified_job_template: formatReference(
      numberOrNull(ujt.id) ?? numberOrNull(node.unified_job_template),
      stringOrNull(ujt.name),
    ),
    approval: isApprovalNode(node, summary)
      ? formatReference(numberOrNull(ujt.id), stringOrNull(ujt.name))
      : null,
    approval_timeout: isApprovalNode(node, summary) ? numberOrNull(ujt.timeout) : null,
    inventory: relationReference(summary.inventory ?? node.inventory),
    execution_environment: relationReference(
      summary.execution_environment ?? node.execution_environment,
    ),
    all_parents_must_converge: booleanOrNull(node.all_parents_must_converge),
    prompt_fields: promptFieldNames(node),
    success_nodes: edgeIds(node.success_nodes),
    failure_nodes: edgeIds(node.failure_nodes),
    always_nodes: edgeIds(node.always_nodes),
  };
}

function toEdgeNode(raw: unknown): RecordValue {
  const node = record(raw);
  const summary = record(node.summary_fields);
  const ujt = unifiedJobTemplate(node, summary);
  const type = unifiedJobType(node, summary);

  return {
    id: numberOrNull(node.id),
    identifier: stringOrNull(node.identifier),
    unified_job_type: type,
    unified_job_template: formatReference(
      numberOrNull(ujt.id) ?? numberOrNull(node.unified_job_template),
      stringOrNull(ujt.name),
    ),
    approval: isApprovalNode(node, summary)
      ? formatReference(numberOrNull(ujt.id), stringOrNull(ujt.name))
      : null,
    all_parents_must_converge: booleanOrNull(node.all_parents_must_converge),
  };
}

function* templateNodesPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, NODES_LIMIT, "template-nodes");
  const workflow = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow job template",
    listCommand: "workflow list",
    command: "workflow template-nodes",
  });
  const paged = yield* readPaged(
    `workflow_job_templates/${workflow}/workflow_nodes/`,
    {},
    limit,
  );

  return listOutput({
    label: "workflow_template_nodes",
    rows: paged.rows.map(toTemplateNodeRow),
    count: paged.count,
    empty: `0 workflow template nodes found for workflow template ${workflow}`,
    help: [
      "Run `awx-axi workflow template-node <id>` for node detail and edge targets",
      `Run \`awx-axi workflow show ${workflow}\` for workflow template settings`,
    ],
  });
}

function* templateNodePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = workflowNodeId(input.args[0] ?? "", "workflow template node id");
  const limit = positiveLimit(input.flags.limit, NODES_LIMIT, "template-node");
  const detail = yield* read(`workflow_job_template_nodes/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `workflow template node ${id}` });
  }

  const credentials = yield* readPaged(
    `workflow_job_template_nodes/${id}/credentials/`,
    {},
    limit,
  );
  const success = yield* readPaged(
    `workflow_job_template_nodes/${id}/success_nodes/`,
    {},
    limit,
  );
  const failure = yield* readPaged(
    `workflow_job_template_nodes/${id}/failure_nodes/`,
    {},
    limit,
  );
  const always = yield* readPaged(
    `workflow_job_template_nodes/${id}/always_nodes/`,
    {},
    limit,
  );

  const node = record(detail.body);
  const summary = record(node.summary_fields);
  const ujt = unifiedJobTemplate(node, summary);
  const type = unifiedJobType(node, summary);
  const workflowTemplateValue =
    summary.workflow_job_template ?? node.workflow_job_template;
  const workflowTemplate = relationReference(workflowTemplateValue);
  const workflowTemplateId =
    numberOrNull(record(workflowTemplateValue).id) ??
    numberOrNull(workflowTemplateValue);
  const fields: RecordValue = {
    id,
    identifier: stringOrNull(node.identifier),
    workflow_template: workflowTemplate,
    unified_job_type: type,
    unified_job_template: formatReference(
      numberOrNull(ujt.id) ?? numberOrNull(node.unified_job_template),
      stringOrNull(ujt.name),
    ),
    approval: approvalDetails(node, summary),
    inventory: relationReference(summary.inventory ?? node.inventory),
    credentials: credentials.rows.map(toCredentialContext),
    credentials_total: credentials.count ?? credentials.rows.length,
    execution_environment: relationReference(
      summary.execution_environment ?? node.execution_environment,
    ),
    all_parents_must_converge: booleanOrNull(node.all_parents_must_converge),
    ...promptFields(node),
    success_nodes: success.rows.map(toEdgeNode),
    success_nodes_total: success.count ?? success.rows.length,
    failure_nodes: failure.rows.map(toEdgeNode),
    failure_nodes_total: failure.count ?? failure.rows.length,
    always_nodes: always.rows.map(toEdgeNode),
    always_nodes_total: always.count ?? always.rows.length,
  };

  const templateArgument = workflowTemplateId === null
    ? "<id|name>"
    : String(workflowTemplateId);
  return detailOutput({
    label: "workflow_template_node",
    fields: redactValue(fields) as RecordValue,
    help: [
      `Run \`awx-axi workflow template-nodes ${templateArgument}\` to inspect the complete template graph`,
      workflowTemplate === null
        ? "Run `awx-axi workflow list` to find the workflow template"
        : `Run \`awx-axi workflow show ${templateArgument}\` for template settings`,
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
    const extraVarsObj = parseExtraVars(input.flags["extra-vars"]);
    payload.extra_vars = JSON.stringify(extraVarsObj);
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
    const extraVarsObj = parseExtraVars(input.flags["extra-vars"]);
    payload.extra_vars = JSON.stringify(extraVarsObj);
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

function* deleteWorkflowPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "workflow_job_templates/",
    noun: "workflow",
    listCommand: "workflow list",
    command: "workflow delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        workflow: id,
        would_send: `DELETE workflow_job_templates/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`workflow_job_templates/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `workflow ${id}` });
  }

  return detailOutput({
    label: "workflow",
    fields: {
      id,
      status: "deleted",
    },
  });
}

export const workflowDomain: Domain = defineDomain({
  name: "workflow",
  help: [
    "workflow: workflow job templates, template graphs, and run node rollups",
    "",
    "Subcommands:",
    "  create   [<name>] [--organization <o>] [--confirm] [--dry-run]",
    "  edit     <id|name> [--name <n>] [--confirm] [--dry-run]",
    "  copy     <id|name> [--name <name>] [--confirm] [--dry-run]",
    "  delete   <id|name> [--confirm] [--dry-run]",
    "  label-add|label-remove <id|name> --label <id> [--confirm] [--dry-run]",
    "  list     [--search <s>] [--limit <n>]",
    "  show     <id|name>",
    "  object-roles <id|name> [--limit <n>]",
    "  survey   <id|name>",
    "  launch   <id|name> [--extra-vars '<json>'] [--wait] [--confirm] [--dry-run]",
    "  nodes    <run-id>",
    "  template-nodes <id|name> [--limit <n>]   editable template graph",
    "  template-node <id> [--limit <n>]         node detail and edges",
    "  node-create|node-edit|node-delete|node-link|node-add-approval",
    "  notification-add|notification-remove <id|name> --event <event> --notification-template <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_workflow_job_templates",
    "get_workflow_job_template",
    "get_workflow_job_template_survey",
    "launch_workflow_job_template",
    "get_workflow_job_nodes",
    "create_workflow_job_template",
    "update_workflow_job_template",
    "delete_workflow_job_template",
  ],
  subcommands: [
    {
      name: "object-roles",
      help: "awx-axi workflow object-roles <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "object_roles", defaultFields: ["id", "name", "description", "type"], fieldAllowlist: [] },
      suggestions: [],
      plan: objectRolesPlan,
    },
    {
      name: "node-create", help: "awx-axi workflow node-create <workflow> --template <id|name> [--confirm] [--dry-run]",
      flags: [{ name: "template", description: "unified job template id or name", takesValue: true }, { name: "inventory", description: "inventory id or name", takesValue: true }, { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true }, { name: "limit", description: "host limit", takesValue: true }, { name: "scm-branch", description: "SCM branch", takesValue: true }, { name: "job-type", description: "run or check", takesValue: true }, { name: "job-tags", description: "job tags", takesValue: true }, { name: "skip-tags", description: "skip tags", takesValue: true }, { name: "verbosity", description: "verbosity", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "workflow_node", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: createNodePlan,
    },
    {
      name: "node-edit", help: "awx-axi workflow node-edit <id> [--template <id|name>] [--confirm] [--dry-run]",
      flags: [{ name: "template", description: "unified job template id or name", takesValue: true }, { name: "inventory", description: "inventory id or name", takesValue: true }, { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true }, { name: "limit", description: "host limit", takesValue: true }, { name: "scm-branch", description: "SCM branch", takesValue: true }, { name: "job-type", description: "run or check", takesValue: true }, { name: "job-tags", description: "job tags", takesValue: true }, { name: "skip-tags", description: "skip tags", takesValue: true }, { name: "verbosity", description: "verbosity", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id>"], required: 1 }, schema: { label: "workflow_node", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: editNodePlan,
    },
    {
      name: "node-delete", help: "awx-axi workflow node-delete <id> [--confirm] [--dry-run]", flags: [{ name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id>"], required: 1 }, schema: { label: "workflow_node", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: deleteNodePlan,
    },
    {
      name: "node-link", help: "awx-axi workflow node-link <node-id> --on <success|failure|always> --to <node-id> [--confirm] [--dry-run]", flags: [{ name: "on", description: "edge type", takesValue: true }, { name: "to", description: "target node id", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<node-id>"], required: 1 }, schema: { label: "workflow_edge", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: linkNodePlan,
    },
    {
      name: "node-unlink", help: "awx-axi workflow node-unlink <node-id> --on <success|failure|always> --to <node-id> [--confirm] [--dry-run]", flags: [{ name: "on", description: "edge type", takesValue: true }, { name: "to", description: "target node id", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<node-id>"], required: 1 }, schema: { label: "workflow_edge", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: (input) => linkNodePlan(input, true),
    },
    ...(["credential", "label", "instance-group"] as const).flatMap((kind) => [
      { name: `node-${kind}-add`, help: `awx-axi workflow node-${kind}-add <node-id> --${kind} <${kind === "credential" ? "id|name" : "id"}> [--confirm] [--dry-run]`, flags: [{ name: kind, description: `${kind} ${kind === "credential" ? "id or name" : "id"}`, takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<node-id>"], required: 1 }, schema: { label: "workflow_node_association", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: nodeAssociationPlan(kind, false) },
      { name: `node-${kind}-remove`, help: `awx-axi workflow node-${kind}-remove <node-id> --${kind} <${kind === "credential" ? "id|name" : "id"}> [--confirm] [--dry-run]`, flags: [{ name: kind, description: `${kind} ${kind === "credential" ? "id or name" : "id"}`, takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<node-id>"], required: 1 }, schema: { label: "workflow_node_association", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: nodeAssociationPlan(kind, true) },
    ]),
    {
      name: "node-add-approval", help: "awx-axi workflow node-add-approval <node-id> --name <name> [--timeout <seconds>] [--confirm] [--dry-run]", flags: [{ name: "name", description: "approval name", takesValue: true }, { name: "description", description: "description", takesValue: true }, { name: "timeout", description: "timeout seconds", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<node-id>"], required: 1 }, schema: { label: "approval_template", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: approvalNodePlan,
    },
    ...(["notification-add", "notification-remove"] as const).map((name) => ({ name, help: `awx-axi workflow ${name} <id|name> --event <event> --notification-template <id|name> [--confirm] [--dry-run]`, flags: [{ name: "event", description: "started, success, error, or approval", takesValue: true }, { name: "notification-template", description: "notification template id or name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "workflow_notification", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: notificationAssociationPlan(name.endsWith("remove")) })),
    ...(["label-add", "label-remove"] as const).map((name) => ({
      name,
      help: `awx-axi workflow ${name} <id|name> --label <id> [--confirm] [--dry-run]`,
      flags: [
        { name: "label", description: "label id", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "preview without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "workflow_label", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: workflowLabelPlan(name.endsWith("remove")),
    })),
    {
      name: "copy",
      help: "awx-axi workflow copy <id|name> [--name <name>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "copied workflow name", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "preview without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "workflow", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: copyWorkflowPlan,
    },
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
      name: "delete",
      help: "awx-axi workflow delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "workflow", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteWorkflowPlan,
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
    {
      name: "template-nodes",
      help: [
        "awx-axi workflow template-nodes <id|name> [--limit <n>]",
        "",
        "Lists editable nodes in a workflow job template. This is distinct from",
        "`workflow nodes`, which inspects nodes of a workflow job run.",
        "",
        "Examples:",
        "  awx-axi workflow template-nodes 10",
        "  awx-axi workflow template-nodes \"Release pipeline\" --limit 50",
      ].join("\n"),
      flags: [
        { name: "limit", description: "nodes to return", takesValue: true },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "workflow_template_nodes",
        defaultFields: ["id", "identifier", "unified_job_type", "unified_job_template", "prompt_fields", "success_nodes", "failure_nodes", "always_nodes"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: templateNodesPlan,
    },
    {
      name: "template-node",
      help: [
        "awx-axi workflow template-node <id> [--limit <n>]",
        "",
        "Shows one editable workflow-template node, its launch prompts,",
        "credentials and runtime context, convergence setting, and edge targets.",
        "This is distinct from `workflow nodes <run-id>`.",
        "",
        "Examples:",
        "  awx-axi workflow template-node 71",
        "  awx-axi workflow template-node 71 --limit 20",
      ].join("\n"),
      flags: [
        { name: "limit", description: "credentials or edge targets to return per relation", takesValue: true },
      ],
      positionals: { names: ["<id>"], required: 1 },
      schema: { label: "workflow_template_node", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: templateNodePlan,
    },
  ],
});
