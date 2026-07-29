/**
 * The `template` domain: job templates - the launch enabler (design.md §7.4).
 *
 * Job templates exist in v1 only because a job cannot be launched without one.
 * `template list`, `template show`, `template survey`, and `template launch`
 * are the launch enabler.
 */
import { statSync, readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { AwxAxiError, errorForResponse, validationError } from "../../core/errors.js";
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
    // try standard JSON object or fail
  }
  throw validationError("--extra-vars is neither valid JSON nor valid YAML", [
    `Provide extra vars as a JSON object string, e.g. --extra-vars '{"env":"prod"}'`,
  ]);
}

function readPasswordsFile(filePath: string): Record<string, unknown> {
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

  if (input.flags["dry-run"] === true) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "launch",
        template: id,
        would_send: `POST job_templates/${id}/launch/`,
      },
      help: ["Re-run without --dry-run to launch"],
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

export const templateDomain: Domain = defineDomain({
  name: "template",
  help: [
    "template: job templates - the launch enabler",
    "",
    "Subcommands:",
    "  list     [--project <p>] [--search <s>] [--limit <n>]",
    "  show     <id|name>",
    "  survey   <id|name>",
    "  launch   <id|name> [--limit <h>] [--extra-vars '<json>'] [--wait] [--dry-run]",
  ].join("\n"),
  mcpEquivalents: [
    "list_job_templates",
    "get_job_template",
    "get_job_template_survey",
    "launch_job_template",
  ],
  subcommands: [
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
      help: "awx-axi template launch <id|name> [--limit <h>] [--extra-vars '<json>'] [--wait] [--dry-run]",
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
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "job", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: launchPlan,
    },
  ],
});
