/**
 * A fake domain, defined in the tests, that exercises the request-declaration
 * model against the real flows (design.md §10.2, §11.2).
 *
 * It lives here and not in `src/domains/` deliberately: every real domain is a
 * later task. What it proves is that a domain can express a multi-request read,
 * a resolve-then-write whose second route depends on the first response, the
 * §9.2 405 disambiguation, and the §7.9 poll loop, while executing nothing
 * itself and importing no HTTP.
 */
import { AxiError } from "axi-sdk-js";

import { AwxAxiError, errorForResponse } from "../../src/core/errors.js";
import { detailOutput, listOutput, project } from "../../src/core/output.js";
import { isActiveStatus, pollUntilTerminal, succeeded } from "../../src/core/poll.js";
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
} from "../../src/core/registry.js";
import { resolveId, resolveUnifiedJob } from "../../src/core/resolve.js";

const EMPTY_SCHEMA = {
  label: "gadgets",
  defaultFields: ["id", "name", "status"],
  fieldAllowlist: ["elapsed"],
} as const;

/**
 * A multi-request read: the unified-job type resolve determines the detail
 * route, and the host rollup is the follow-up an agent asks for every time.
 */
function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = Number(input.args[0]);
  const unified = yield* resolveUnifiedJob(id);

  const detail = yield* read(`${unified.type}s/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `job ${id}` });
  }

  const hosts = yield* readPaged(`jobs/${id}/job_events/`, {}, 50);
  const body = detail.body as Record<string, unknown>;

  return detailOutput({
    label: "job",
    fields: {
      id,
      type: unified.type,
      name: body.name,
      status: body.status,
      events: hosts.count ?? hosts.rows.length,
    },
  });
}

/**
 * A resolve-then-write: the launch path cannot be built until the name resolve
 * comes back, and the preflight response decides whether the write happens at
 * all (§7.5).
 */
function* launchPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "job_templates/",
    noun: "job template",
    listCommand: "gadget list",
    command: "gadget launch",
  });

  const preflight = yield* read(`job_templates/${id}/launch/`);
  if (preflight.status !== 200) {
    throw errorForResponse(preflight, { subject: `template ${id}` });
  }
  const capabilities = preflight.body as Record<string, unknown>;
  const limit = input.flags.limit;

  if (typeof limit === "string" && capabilities.ask_limit_on_launch !== true) {
    throw new AwxAxiError(
      `template ${id} does not accept --limit at launch; the job would run against the whole inventory`,
      "LAUNCH_WOULD_IGNORE_INPUT",
      [
        `Run \`awx-axi gadget launch ${id}\` to launch with the template's own limit`,
        `Run \`awx-axi gadget show ${id}\` to see which flags this template accepts`,
      ],
      {
        ignored: [
          {
            flag: "--limit",
            reason: "ask_limit_on_launch is disabled on this template",
          },
        ],
      },
    );
  }

  const needed = capabilities.variables_needed_to_start;
  if (Array.isArray(needed) && needed.length > 0) {
    throw new AwxAxiError(
      `template ${id} needs ${needed.length} survey variable(s) before it can launch`,
      "LAUNCH_INPUT_REQUIRED",
      [`Run \`awx-axi gadget survey ${id}\` to see the required questions`],
      { needed },
    );
  }

  const launch = yield* write(
    `job_templates/${id}/launch/`,
    typeof limit === "string" ? { limit } : {},
  );
  if (launch.status !== 201) {
    throw errorForResponse(launch, {
      subject: `template ${id}`,
      codes: { 400: "LAUNCH_REJECTED" },
    });
  }

  const job = launch.body as Record<string, unknown>;
  const ignored = (job.ignored_fields ?? {}) as Record<string, unknown>;
  const ignoredRows = Object.entries(ignored).map(([field, submitted]) => ({
    field,
    submitted: String(submitted),
  }));

  // The job is running, so this is exit 0 with a warning: an agent that reads a
  // failure exit code while a job is actually running is liable to relaunch it
  // (§7.5).
  return {
    job: { id: job.id, template: id, status: job.status },
    ...(ignoredRows.length === 0
      ? {}
      : {
          warning: `${ignoredRows.length} field was ignored by the controller and the job is running without it`,
          ignored: ignoredRows,
        }),
    help: [
      `Run \`awx-axi gadget cancel ${String(job.id)}\` if this is not what you wanted`,
      `Run \`awx-axi gadget watch ${String(job.id)}\` to follow it to completion`,
    ],
  };
}

/** The §9.2 disambiguation for a job: a bare 405 costs exactly one read. */
function* cancelPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = Number(input.args[0]);
  const response = yield* write(`jobs/${id}/cancel/`);

  if (response.status === 202) {
    return { job: { id, status: "canceled" } };
  }
  if (response.status !== 405) {
    throw errorForResponse(response, { subject: `job ${id}` });
  }

  const detail = yield* read(`jobs/${id}/`);
  const status = (detail.body as { status?: string } | null)?.status ?? "";

  if (!isActiveStatus(status)) {
    return {
      job: `${id} already finished (${status}), nothing to cancel (no-op)`,
      help: [`Run \`awx-axi gadget relaunch ${id}\` to run it again`],
    };
  }

  throw new AxiError(
    `job ${id} is ${status} but the controller refused to cancel it`,
    "SERVER_ERROR",
    [`Run \`awx-axi gadget show ${id}\` to see its current state`],
  );
}

/** The §9.2 disambiguation for a project: the same 405, a different outcome. */
function* syncPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = Number(input.args[0]);
  const response = yield* write(`projects/${id}/update/`);

  if (response.status === 202) {
    return { project: { id, status: "syncing" } };
  }
  if (response.status !== 405) {
    throw errorForResponse(response, { subject: `project ${id}` });
  }

  const detail = yield* read(`projects/${id}/`);
  const body = (detail.body ?? {}) as Record<string, unknown>;

  if (body.scm_type === "") {
    throw new AxiError(
      `project ${id} has no SCM source to sync from`,
      "SYNC_UNAVAILABLE",
      [`Run \`awx-axi gadget show ${id}\` to see how this project is configured`],
    );
  }

  const running = (body.current_update ?? {}) as Record<string, unknown>;
  return {
    project: `${id} is already syncing as ${String(running.id)} (no-op)`,
    help: [`Run \`awx-axi gadget watch ${String(running.id)}\` to follow it`],
  };
}

/** The §7.9 bounded poll loop, driven by an injected clock in the tests. */
export interface WatchClock {
  now(): number;
}

export let watchClock: WatchClock = { now: () => Date.now() };

export function setWatchClock(clock: WatchClock): void {
  watchClock = clock;
}

function* watchPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = Number(input.args[0]);
  const timeout = input.flags.timeout;

  const result = yield* pollUntilTerminal({
    route: `jobs/${id}/`,
    resumeCommand: `awx-axi gadget watch ${id}`,
    now: () => watchClock.now(),
    intervalMs: 5_000,
    ...(typeof timeout === "string"
      ? { timeoutMs: Number(timeout) * 1000 }
      : {}),
  });

  const block = detailOutput({
    label: "job",
    fields: {
      id,
      status: result.status,
      polls: result.polls,
    },
  });

  // §7.9: the exit code follows the watched job, and the block is still printed
  // as output rather than as an error - the command did exactly what it was
  // asked to do.
  return succeeded(result.status) ? block : withExitCode(block, 1);
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const paged = yield* readPaged("unified_jobs/", {}, 450);

  return listOutput({
    label: EMPTY_SCHEMA.label,
    rows: paged.rows.map((row) =>
      project(row as Record<string, unknown>, [...EMPTY_SCHEMA.defaultFields]),
    ),
    count: paged.count,
    empty: `0 gadgets found${input.flags.failed === true ? " that failed" : ""}`,
  });
}

export const fakeDomain: Domain = defineDomain({
  name: "gadget",
  help: "gadget: a fake domain that exists only in the offline suite",
  mcpEquivalents: [],
  subcommands: [
    {
      name: "list",
      help: "gadget list [--failed]",
      flags: [{ name: "failed", description: "only failures", takesValue: false }],
      maxArgs: 0,
      schema: EMPTY_SCHEMA,
      suggestions: [],
      plan: listPlan,
    },
    {
      name: "show",
      help: "gadget show <id>",
      flags: [],
      maxArgs: 1,
      schema: EMPTY_SCHEMA,
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "launch",
      help: "gadget launch <id|name> [--limit <hosts>]",
      flags: [
        { name: "limit", description: "host pattern", takesValue: true },
        { name: "status", description: "unused, for the hint test", takesValue: true },
      ],
      maxArgs: 1,
      schema: EMPTY_SCHEMA,
      suggestions: [],
      plan: launchPlan,
    },
    {
      name: "cancel",
      help: "gadget cancel <id>",
      flags: [],
      maxArgs: 1,
      schema: EMPTY_SCHEMA,
      suggestions: [],
      plan: cancelPlan,
    },
    {
      name: "sync",
      help: "gadget sync <id>",
      flags: [],
      maxArgs: 1,
      schema: EMPTY_SCHEMA,
      suggestions: [],
      plan: syncPlan,
    },
    {
      name: "watch",
      help: "gadget watch <id> [--timeout <seconds>]",
      flags: [
        { name: "timeout", description: "seconds", takesValue: true },
      ],
      maxArgs: 1,
      schema: EMPTY_SCHEMA,
      suggestions: [],
      plan: watchPlan,
    },
  ],
});
