/**
 * The `template` domain: manage and launch job templates (design.md §7.4).
 */
import { statSync, readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { AwxAxiError, errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive, parseInteger } from "../../core/mutations.js";
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

const LIST_SCHEMA = {
  label: "job_templates",
  defaultFields: ["id", "name", "project", "last_job_run"],
  fieldAllowlist: [
    "description",
    "job_type",
    "inventory",
    "playbook",
    "forks",
    "limit",
    "verbosity",
  ],
} as const;

function toTemplateRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const project = (summary.project ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    project: typeof project.name === "string" ? project.name : null,
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
      `--limit must be a positive integer for \`template ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi template ${subcommand} --limit ${fallback}\``],
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
  if (typeof input.flags.project === "string") {
    query.project = input.flags.project;
  }

  const paged = yield* readPaged("job_templates/", query, limit);
  const rows = paged.rows.map(toTemplateRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 job templates found",
    help: [
      "Run `awx-axi template show <id|name>` to see what a template accepts at launch",
      "Run `awx-axi template launch <id|name>` to launch a template",
    ],
  });
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
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template object-roles",
  });
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "object-roles");
  const paged = yield* readPaged(`job_templates/${id}/object_roles/`, {}, limit);
  return listOutput({
    label: "object_roles",
    rows: paged.rows.map(toRoleRow),
    count: paged.count,
    empty: "0 object roles found for template",
    help: [`Run \`awx-axi role show <id|name>\` to inspect role detail`],
  });
}

function computePromptsOnLaunch(body: Record<string, unknown>): string[] {
  const promptableFlags: [string, string][] = [
    ["ask_limit_on_launch", "limit"],
    ["ask_inventory_on_launch", "inventory"],
    ["ask_credential_on_launch", "credentials"],
    ["ask_verbosity_on_launch", "verbosity"],
    ["ask_job_type_on_launch", "job_type"],
    ["ask_tags_on_launch", "job_tags"],
    ["ask_skip_tags_on_launch", "skip_tags"],
    ["ask_variables_on_launch", "extra_vars"],
    ["ask_scm_branch_on_launch", "scm_branch"],
    ["ask_diff_mode_on_launch", "diff_mode"],
  ];

  const result: string[] = [];
  for (const [key, label] of promptableFlags) {
    if (body[key] === true) {
      result.push(label);
    }
  }
  return result;
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template show",
  });

  const detail = yield* read(`job_templates/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `template ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const project = (summary.project ?? {}) as Record<string, unknown>;
  const inventory = (summary.inventory ?? {}) as Record<string, unknown>;
  const lastJob = (summary.last_job ?? {}) as Record<string, unknown>;

  const prompts = computePromptsOnLaunch(body);
  const surveyEnabled = body.survey_enabled === true;

  const fields: Record<string, unknown> = {
    id,
    name: body.name ?? null,
    project: project.name !== undefined ? `${project.id ?? ""} (${project.name})` : null,
    playbook: body.playbook ?? null,
    inventory: inventory.name !== undefined ? `${inventory.id ?? ""} (${inventory.name})` : null,
    last_run: lastJob.id !== undefined ? `${lastJob.id} ${lastJob.status ?? ""}` : null,
    prompts_on_launch: prompts,
    survey: surveyEnabled ? "enabled" : "disabled",
    needs_at_launch: "none",
  };

  return detailOutput({
    label: "template",
    fields,
    help: [
      `Run \`awx-axi template survey ${id}\` for the survey questions`,
      `Run \`awx-axi template launch ${id}\` to launch`,
    ],
  });
}

function* surveyPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template survey",
  });

  const surveyRes = yield* read(`job_templates/${id}/survey_spec/`);
  if (surveyRes.status !== 200) {
    throw errorForResponse(surveyRes, { subject: `template ${id} survey` });
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
      template: id,
      name: body.name ?? null,
      description: body.description ?? null,
      questions,
    },
    help: [
      `Run \`awx-axi template launch ${id} --extra-vars '{"var": "val"}'\` to launch with survey responses`,
    ],
  });
}

export function parseExtraVars(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // try standard JSON object or fail
  }
  throw validationError("--extra-vars is neither valid JSON nor valid YAML", [
    `Provide extra vars as a JSON object string, e.g. --extra-vars '{"env":"prod"}'`,
  ]);
}

export function readPasswordsFile(filePath: string): Record<string, unknown> {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw validationError(`credential passwords file "${filePath}" could not be read`);
  }

  if ((stats.mode & 0o077) !== 0) {
    throw validationError(
      `credential passwords file "${filePath}" is group- or world-readable; permissions must be 0600`,
    );
  }

  const content = readFileSync(filePath, "utf8");
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fail
  }
  throw validationError(`credential passwords file "${filePath}" must contain a JSON object`);
}

function* launchPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template launch",
  });

  const preflightRes = yield* read(`job_templates/${id}/launch/`);
  if (preflightRes.status !== 200) {
    throw errorForResponse(preflightRes, { subject: `template ${id} launch preflight` });
  }

  const preflight = (preflightRes.body ?? {}) as Record<string, unknown>;
  const ignoredFlags: { flag: string; reason: string }[] = [];

  const checkFlag = (flagName: string, promptKey: string) => {
    if (input.flags[flagName] !== undefined && preflight[promptKey] !== true) {
      ignoredFlags.push({
        flag: `--${flagName}`,
        reason: `${promptKey} is disabled on this template`,
      });
    }
  };

  checkFlag("limit", "ask_limit_on_launch");
  checkFlag("tags", "ask_tags_on_launch");
  checkFlag("skip-tags", "ask_skip_tags_on_launch");
  checkFlag("extra-vars", "ask_variables_on_launch");
  checkFlag("inventory", "ask_inventory_on_launch");
  checkFlag("scm-branch", "ask_scm_branch_on_launch");
  checkFlag("verbosity", "ask_verbosity_on_launch");
  checkFlag("job-type", "ask_job_type_on_launch");
  checkFlag("diff", "ask_diff_mode_on_launch");

  if (ignoredFlags.length > 0) {
    throw new AwxAxiError(
      `template ${id} does not accept ${ignoredFlags.map((i) => i.flag).join(", ")} at launch; input would be ignored`,
      "LAUNCH_WOULD_IGNORE_INPUT",
      [
        `Run \`awx-axi template launch ${id}\` to launch without ignored flags`,
        `Run \`awx-axi template show ${id}\` to see which flags this template accepts`,
      ],
      { ignored: ignoredFlags },
    );
  }

  const passwordsNeeded = preflight.passwords_needed_to_start;
  let credentialPasswords: Record<string, unknown> | undefined;

  if (Array.isArray(passwordsNeeded) && passwordsNeeded.length > 0) {
    const allowPasswords = input.context.env.AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS === "1";
    const passFile = typeof input.flags["credential-passwords-file"] === "string"
      ? input.flags["credential-passwords-file"]
      : undefined;

    if (!allowPasswords || passFile === undefined) {
      throw new AxiError(
        `template ${id} requires credential passwords at launch (${passwordsNeeded.join(", ")})`,
        "LAUNCH_INPUT_REQUIRED",
        [
          "Set AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS=1 and provide --credential-passwords-file <path>",
        ],
      );
    }
    credentialPasswords = readPasswordsFile(passFile);
  }

  const varsNeeded = preflight.variables_needed_to_start;
  const extraVarsObj = parseExtraVars(
    typeof input.flags["extra-vars"] === "string" ? input.flags["extra-vars"] : undefined,
  );

  if (Array.isArray(varsNeeded) && varsNeeded.length > 0) {
    const missing = varsNeeded.filter((v) => typeof v === "string" && !(v in extraVarsObj));
    if (missing.length > 0) {
      throw new AxiError(
        `template ${id} requires survey variables at launch: ${missing.join(", ")}`,
        "LAUNCH_INPUT_REQUIRED",
        [
          `Run \`awx-axi template survey ${id}\` to see required survey questions`,
          `Re-run with --extra-vars '{"${missing[0]}":"<value>"}'`,
        ],
      );
    }
  }

  const launchBody: Record<string, unknown> = {};
  if (typeof input.flags.limit === "string") launchBody.limit = input.flags.limit;
  if (typeof input.flags.tags === "string") launchBody.job_tags = input.flags.tags;
  if (typeof input.flags["skip-tags"] === "string") launchBody.skip_tags = input.flags["skip-tags"];
  if (typeof input.flags["extra-vars"] === "string") launchBody.extra_vars = JSON.stringify(extraVarsObj);
  if (typeof input.flags.inventory === "string") launchBody.inventory = Number(input.flags.inventory);
  if (typeof input.flags["scm-branch"] === "string") launchBody.scm_branch = input.flags["scm-branch"];
  if (typeof input.flags.verbosity === "string") launchBody.verbosity = Number(input.flags.verbosity);
  if (typeof input.flags["job-type"] === "string") launchBody.job_type = input.flags["job-type"];
  if (input.flags.diff === true) launchBody.diff_mode = true;
  if (credentialPasswords !== undefined) launchBody.credential_passwords = credentialPasswords;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "launch",
        template: id,
        would_send: `POST job_templates/${id}/launch/`,
      },
      help: ["Re-run with --confirm to launch"],
    });
  }

  const launchRes = yield* write(`job_templates/${id}/launch/`, launchBody);
  if (launchRes.status !== 201 && launchRes.status !== 200 && launchRes.status !== 202) {
    throw errorForResponse(launchRes, {
      subject: `template ${id}`,
      codes: { 400: "LAUNCH_REJECTED" },
    });
  }

  const resBody = (launchRes.body ?? {}) as Record<string, unknown>;
  const jobId = typeof resBody.id === "number" ? resBody.id : 0;
  const status = typeof resBody.status === "string" ? resBody.status : "pending";

  const ignoredServerFields = resBody.ignored_fields;
  const hasIgnored =
    ignoredServerFields !== undefined &&
    ignoredServerFields !== null &&
    (Array.isArray(ignoredServerFields)
      ? ignoredServerFields.length > 0
      : Object.keys(ignoredServerFields as Record<string, unknown>).length > 0);

  if (input.flags.wait === true && jobId > 0) {
    const timeoutSec = typeof input.flags.timeout === "string" ? Number(input.flags.timeout) : 600;
    const pollRes = yield* pollUntilTerminal({
      route: `jobs/${jobId}/`,
      timeoutMs: timeoutSec * 1000,
      resumeCommand: `awx-axi job watch ${jobId}`,
    });
    return withExitCode(
      detailOutput({
        label: "job",
        fields: {
          id: jobId,
          template: id,
          status: pollRes.status,
          waited: `${Math.round(pollRes.waitedMs / 1000)}s`,
        },
        help: [`Run \`awx-axi job stdout ${jobId}\` for the output`],
      }),
      succeeded(pollRes.status) ? 0 : 1,
    );
  }

  const fields: Record<string, unknown> = {
    id: jobId,
    template: id,
    status,
  };

  if (hasIgnored) {
    fields.warning = "fields were ignored by the controller and the job is running without them";
    fields.ignored = ignoredServerFields;
  }

  return detailOutput({
    label: "job",
    fields,
    help: [
      `Run \`awx-axi job cancel ${jobId}\` if this is not what you wanted`,
      `Run \`awx-axi job watch ${jobId}\` to follow it to completion`,
    ],
  });
}

function* createPlan(input: SubcommandInput): Plan<DomainResult> {
  const name = input.args[0] ?? (typeof input.flags.name === "string" ? input.flags.name : undefined);
  if (name === undefined || name === "") {
    throw validationError("`template create` needs a template name argument or --name", [
      "Provide a name, e.g. `awx-axi template create \"Deploy Web Tier\" --inventory Production --project AppRepo`",
    ]);
  }

  const payload: Record<string, unknown> = { name };

  if (typeof input.flags.inventory === "string") {
    payload.inventory = yield* resolveId(input.flags.inventory, {
      listRoute: "inventories/",
      noun: "inventory",
      listCommand: "inventory list",
      command: "template create",
    });
  }

  if (typeof input.flags.project === "string") {
    payload.project = yield* resolveId(input.flags.project, {
      listRoute: "projects/",
      noun: "project",
      listCommand: "project list",
      command: "template create",
    });
  }

  if (typeof input.flags["execution-environment"] === "string") {
    payload.execution_environment = yield* resolveId(input.flags["execution-environment"], {
      listRoute: "execution_environments/",
      noun: "execution environment",
      listCommand: "execution-environment list",
      command: "template create",
    });
  }

  if (typeof input.flags.playbook === "string") payload.playbook = input.flags.playbook;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags["extra-vars"] === "string") {
    const extraVarsObj = parseExtraVars(input.flags["extra-vars"]);
    payload.extra_vars = JSON.stringify(extraVarsObj);
  }
  if (typeof input.flags.limit === "string") payload.limit = input.flags.limit;
  if (typeof input.flags.verbosity === "string") payload.verbosity = Number(input.flags.verbosity);
  if (typeof input.flags["job-type"] === "string") payload.job_type = input.flags["job-type"];

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "job_template",
        name,
        would_send: "POST job_templates/",
        payload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("job_templates/", payload, { method: "POST", tag: "config" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `template ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "template",
    fields: {
      id,
      name: body.name ?? name,
    },
    help: [`Run \`awx-axi template show ${id}\` to inspect template`],
  });
}

function* editPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.inventory === "string") {
    payload.inventory = yield* resolveId(input.flags.inventory, {
      listRoute: "inventories/",
      noun: "inventory",
      listCommand: "inventory list",
      command: "template edit",
    });
  }
  if (typeof input.flags.project === "string") {
    payload.project = yield* resolveId(input.flags.project, {
      listRoute: "projects/",
      noun: "project",
      listCommand: "project list",
      command: "template edit",
    });
  }
  if (typeof input.flags["execution-environment"] === "string") {
    payload.execution_environment = yield* resolveId(input.flags["execution-environment"], {
      listRoute: "execution_environments/",
      noun: "execution environment",
      listCommand: "execution-environment list",
      command: "template edit",
    });
  }
  if (typeof input.flags.playbook === "string") payload.playbook = input.flags.playbook;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;
  if (typeof input.flags["extra-vars"] === "string") {
    const extraVarsObj = parseExtraVars(input.flags["extra-vars"]);
    payload.extra_vars = JSON.stringify(extraVarsObj);
  }
  if (typeof input.flags.limit === "string") payload.limit = input.flags.limit;
  if (typeof input.flags.verbosity === "string") payload.verbosity = Number(input.flags.verbosity);
  if (typeof input.flags["job-type"] === "string") payload.job_type = input.flags["job-type"];

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        template: id,
        would_send: `PATCH job_templates/${id}/`,
        payload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`job_templates/${id}/`, payload, { method: "PATCH", tag: "config" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `template ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "template",
    fields: {
      id,
      name: body.name ?? null,
    },
    help: [`Run \`awx-axi template show ${id}\` to inspect updated template`],
  });
}

function* copyPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template copy",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "copy",
        template: id,
        would_send: `POST job_templates/${id}/copy/`,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
      },
      help: ["Re-run with --confirm to copy"],
    });
  }

  const res = yield* write(`job_templates/${id}/copy/`, payload, { method: "POST", tag: "config" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `template ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const newId = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "template",
    fields: {
      id: newId,
      name: body.name ?? null,
    },
    help: [`Run \`awx-axi template show ${newId}\` to inspect copied template`],
  });
}

const TEMPLATE_ASSOCIATIONS: Record<string, { flag: string; route: string; listRoute: string; noun: string; tag: "security" | "config" }> = {
  "credential-add": { flag: "credential", route: "credentials", listRoute: "credentials/", noun: "credential", tag: "security" },
  "credential-remove": { flag: "credential", route: "credentials", listRoute: "credentials/", noun: "credential", tag: "security" },
  "instance-group-add": { flag: "instance-group", route: "instance_groups", listRoute: "instance_groups/", noun: "instance group", tag: "config" },
  "instance-group-remove": { flag: "instance-group", route: "instance_groups", listRoute: "instance_groups/", noun: "instance group", tag: "config" },
  "label-add": { flag: "label", route: "labels", listRoute: "labels/", noun: "label", tag: "config" },
  "label-remove": { flag: "label", route: "labels", listRoute: "labels/", noun: "label", tag: "config" },
};

function associationPlan(operation: string) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const spec = TEMPLATE_ASSOCIATIONS[operation];
    if (spec === undefined) throw validationError("unsupported template association");
    const template = yield* resolveId(input.args[0] ?? "", { listRoute: "job_templates/", noun: "job template", listCommand: "template list", command: `template ${operation}` });
    const raw = input.flags[spec.flag]; if (typeof raw !== "string") throw validationError(`\`template ${operation}\` needs --${spec.flag} id or name`);
    const target = spec.flag === "credential"
      ? yield* resolveId(raw, { listRoute: spec.listRoute, noun: spec.noun, listCommand: "credential list", command: `template ${operation}` })
      : parseInteger(raw, `--${spec.flag}`, 1);
    const remove = operation.endsWith("-remove"); const path = `job_templates/${template}/${spec.route}/`; const payload = remove ? { id: target, disassociate: true } : { id: target };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", spec.noun, { template, [spec.flag]: target }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: spec.tag });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `template ${template}` });
    return detailOutput({ label: "template_association", fields: { template, [spec.flag]: target, status: remove ? "removed" : "added" } });
  };
}

function notificationAssociationPlan(remove: boolean) {
  return function* plan(input: SubcommandInput): Plan<DomainResult> {
    const template = yield* resolveId(input.args[0] ?? "", { listRoute: "job_templates/", noun: "job template", listCommand: "template list", command: `template notification-${remove ? "remove" : "add"}` });
    const event = input.flags.event; if (typeof event !== "string" || !["started", "success", "error"].includes(event)) throw validationError("--event must be started, success, or error");
    if (typeof input.flags["notification-template"] !== "string") throw validationError("notification association needs --notification-template");
    const notificationTemplate = yield* resolveId(input.flags["notification-template"], { listRoute: "notification_templates/", noun: "notification template", listCommand: "notification-template list", command: "template notification" });
    const path = `job_templates/${template}/notification_templates_${event}/`; const payload = remove ? { id: notificationTemplate, disassociate: true } : { id: notificationTemplate };
    if (!isLive(input.flags)) return dryRun(remove ? "remove" : "add", "notification_template", { template, notification_template: notificationTemplate, event }, `POST ${path}`, payload);
    const response = yield* write(path, payload, { method: "POST", tag: "config" });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw errorForResponse(response, { subject: `template ${template} notifications` });
    return detailOutput({ label: "template_notification", fields: { template, notification_template: notificationTemplate, event, status: remove ? "removed" : "added" } });
  };
}

function* deletePlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "template list",
    command: "template delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        template: id,
        would_send: `DELETE job_templates/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`job_templates/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `template ${id}` });
  }

  return detailOutput({
    label: "template",
    fields: {
      id,
      status: "deleted",
    },
  });
}

export const templateDomain: Domain = defineDomain({
  name: "template",
  help: [
    "template: job templates - the launch enabler",
    "",
    "Subcommands:",
    "  create   [<name>] [--inventory <i|name>] [--project <p|name>] [--confirm] [--dry-run]",
    "  edit     <id|name> [--name <n>] [--confirm] [--dry-run]",
    "  delete   <id|name> [--confirm] [--dry-run]",
    "  copy     <id|name> [--name <n>] [--confirm] [--dry-run]",
    "  list     [--project <p>] [--search <s>] [--limit <n>]",
    "  show     <id|name>",
    "  object-roles <id|name> [--limit <n>]",
    "  survey   <id|name>",
    "  launch   <id|name> [--limit <h>] [--extra-vars '<json>'] [--wait] [--confirm] [--dry-run]",
    "  credential-add|credential-remove, instance-group-add|instance-group-remove, label-add|label-remove",
    "  notification-add|notification-remove <id|name> --event <started|success|error> --notification-template <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_job_templates",
    "get_job_template",
    "get_job_template_survey",
    "launch_job_template",
    "create_job_template",
    "update_job_template",
    "delete_job_template",
    "copy_job_template",
  ],
  subcommands: [
    {
      name: "object-roles",
      help: "awx-axi template object-roles <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "object_roles", defaultFields: ["id", "name", "description", "type"], fieldAllowlist: [] },
      suggestions: [],
      plan: objectRolesPlan,
    },
    ...Object.entries(TEMPLATE_ASSOCIATIONS).map(([name, spec]) => ({
      name, help: `awx-axi template ${name} <id|name> --${spec.flag} <${spec.flag === "credential" ? "id|name" : "id"}> [--confirm] [--dry-run]`, flags: [{ name: spec.flag, description: `${spec.noun} ${spec.flag === "credential" ? "id or name" : "id"}`, takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "template_association", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: associationPlan(name),
    })),
    ...(["notification-add", "notification-remove"] as const).map((name) => ({
      name, help: `awx-axi template ${name} <id|name> --event <event> --notification-template <id|name> [--confirm] [--dry-run]`, flags: [{ name: "event", description: "started, success, or error", takesValue: true }, { name: "notification-template", description: "notification template id or name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "template_notification", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: notificationAssociationPlan(name.endsWith("remove")),
    })),
    {
      name: "create",
      help: "awx-axi template create [<name>] [--inventory <i|name>] [--project <p|name>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "template name", takesValue: true },
        { name: "inventory", description: "inventory id or name", takesValue: true },
        { name: "project", description: "project id or name", takesValue: true },
        { name: "playbook", description: "playbook file path", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "execution-environment", description: "execution environment id or name", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "limit", description: "host limit", takesValue: true },
        { name: "verbosity", description: "verbosity level 0-5", takesValue: true },
        { name: "job-type", description: "run or check", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "template", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createPlan,
    },
    {
      name: "edit",
      help: "awx-axi template edit <id|name> [--name <n>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "template name", takesValue: true },
        { name: "inventory", description: "inventory id or name", takesValue: true },
        { name: "project", description: "project id or name", takesValue: true },
        { name: "playbook", description: "playbook file path", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "execution-environment", description: "execution environment id or name", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "limit", description: "host limit", takesValue: true },
        { name: "verbosity", description: "verbosity level 0-5", takesValue: true },
        { name: "job-type", description: "run or check", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "template", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editPlan,
    },
    {
      name: "delete",
      help: "awx-axi template delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "template", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deletePlan,
    },
    {
      name: "copy",
      help: "awx-axi template copy <id|name> [--name <n>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "new template name", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "template", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: copyPlan,
    },
    {
      name: "list",
      help: "awx-axi template list [--project <p>] [--search <s>] [--limit <n>]",
      flags: [
        { name: "project", description: "filter by project", takesValue: true },
        { name: "search", description: "search templates", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        { outcome: "listed", suggestions: ["Run `awx-axi template show <id|name>` for template detail"] },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi template show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "template", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "survey",
      help: "awx-axi template survey <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "survey", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: surveyPlan,
    },
    {
      name: "launch",
      help: "awx-axi template launch <id|name> [--limit <h>] [--extra-vars '<json>'] [--wait] [--confirm] [--dry-run]",
      flags: [
        { name: "limit", description: "host limit", takesValue: true },
        { name: "tags", description: "job tags", takesValue: true },
        { name: "skip-tags", description: "skip tags", takesValue: true },
        { name: "extra-vars", description: "extra vars JSON/YAML", takesValue: true },
        { name: "inventory", description: "inventory id", takesValue: true },
        { name: "scm-branch", description: "SCM branch", takesValue: true },
        { name: "verbosity", description: "verbosity level 0-5", takesValue: true },
        { name: "job-type", description: "run or check", takesValue: true },
        { name: "diff", description: "enable diff mode", takesValue: false },
        { name: "credential-passwords-file", description: "path to credential passwords JSON file", takesValue: true },
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
  ],
});
