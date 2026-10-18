import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { encode } from "@toon-format/toon";
import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";

import { AUTH_HELP, authCommand, type AuthContext } from "./commands/auth.js";
import { homeCommand, homeDiagnostic } from "./commands/home.js";
import { SETUP_HELP, setupCommand } from "./commands/setup.js";
import {
  createBasicAuthTransport,
  createTransport,
  resolveController,
  type Credential,
  type Env,
} from "./core/auth.js";
import { discoverController } from "./core/controller-discovery.js";
import { formatError, validationError } from "./core/errors.js";
import { configPath, loadConfig, normalizeEnv, type Selection } from "./core/profiles.js";
import { clearSecrets, redact } from "./core/redact.js";
import {
  splitResult,
  type Domain,
  type DomainContext,
} from "./core/registry.js";
import { HttpTransport, type AwxTransport } from "./core/transport.js";
import { organizationDomain } from "./domains/organization/index.js";
import { approvalDomain } from "./domains/approval/index.js";
import { adHocDomain } from "./domains/ad-hoc/index.js";
import { credentialDomain } from "./domains/credential/index.js";
import { executionEnvironmentDomain } from "./domains/execution-environment/index.js";
import { jobDomain } from "./domains/job/index.js";
import { inventoryDomain } from "./domains/inventory/index.js";
import { projectDomain } from "./domains/project/index.js";
import { scheduleDomain } from "./domains/schedule/index.js";
import { templateDomain } from "./domains/template/index.js";
import { workflowDomain } from "./domains/workflow/index.js";
import { systemJobDomain } from "./domains/system-job/index.js";
import { systemJobTemplateDomain } from "./domains/system-job-template/index.js";
import { userDomain } from "./domains/user/index.js";
import { notificationDomain } from "./domains/notification/index.js";
import { notificationTemplateDomain } from "./domains/notification-template/index.js";
import { activityStreamDomain } from "./domains/activity-stream/index.js";
import { teamDomain } from "./domains/team/index.js";
import { roleDomain } from "./domains/role/index.js";
import { hostDomain } from "./domains/host/index.js";
import { groupDomain } from "./domains/group/index.js";
import { inventorySourceDomain } from "./domains/inventory-source/index.js";

export const DESCRIPTION = "Inspect and run AWX automation from the shell";

/**
 * Noun to domain-module map (design.md §10.1).
 *
 * The list lives here rather than in `core/registry.ts` because every domain
 * imports the registry for its contract types, so holding the list there would
 * be a circular import.
 */
export const DOMAINS: readonly Domain[] = [
  jobDomain,
  templateDomain,
  workflowDomain,
  organizationDomain,
  systemJobTemplateDomain,
  systemJobDomain,
  credentialDomain,
  approvalDomain,
  adHocDomain,
  projectDomain,
  inventoryDomain,
  hostDomain,
  groupDomain,
  inventorySourceDomain,
  scheduleDomain,
  executionEnvironmentDomain,
  userDomain,
  notificationDomain,
  notificationTemplateDomain,
  activityStreamDomain,
  teamDomain,
  roleDomain,
];

export interface MainOptions {
  readonly argv?: string[];
  readonly stdout?: { write: (chunk: string) => unknown };
  readonly env?: Env;
  /** Injected offline by the test suite; `HttpTransport` in production. */
  readonly createTransport?: (env: Env, signal?: AbortSignal) => AwxTransport;
  readonly createBasicAuthTransport?: (env: Env) => AwxTransport;
  /** Injected offline so `HttpTransport` in production. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function main(options: MainOptions = {}): Promise<void> {
  clearSecrets();
  let argv = options.argv ?? process.argv.slice(2);
  const bareHome = argv.length === 0;
  const env = normalizeEnv(options.env ?? process.env);
  const selection: Selection = {};
  let globalError: unknown;
  try {
    const remaining: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index]!;
      const [name] = token.split("=", 1);
      if (!["--config", "--profile", "--origin", "--verify-ssl"].includes(name!)) { remaining.push(token); continue; }
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[++index];
      if (!value || value.startsWith("--")) throw validationError(`${name} requires a value`);
      if (name === "--config") selection.configPath = value;
      if (name === "--profile") selection.profile = value;
      if (name === "--origin") selection.origin = value;
      if (name === "--verify-ssl") {
        if (!["true", "false"].includes(value)) throw validationError("--verify-ssl requires true or false");
        selection.verifySsl = value === "true";
      }
    }
    argv = remaining;
  } catch (error) { globalError = error; }
  if (globalError) {
    const error = formatError(globalError);
    (options.stdout ?? process.stdout).write(redact(error.output));
    process.exitCode = error.exitCode;
    return;
  }
  const homeCancellation = argv.length === 0 ? new AbortController() : undefined;
  const context: DomainContext & AuthContext = {
    env,
    selection,
    createTransport: (credential?: Credential) => options.createTransport === undefined
      ? createTransport(env, selection, credential, homeCancellation?.signal)
      : options.createTransport(env, homeCancellation?.signal),
    createBasicAuthTransport: () => options.createBasicAuthTransport === undefined
      ? createBasicAuthTransport(env, selection)
      : options.createBasicAuthTransport(env),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
  const commands = buildCommands(context);
  let home: Record<string, unknown> | undefined;
  if (argv.length === 0) {
    const deadline = setTimeout(() => homeCancellation!.abort(), 8_000);
    try {
      const controller = resolveController(env, selection);
      const metadata = await discoverController(controller, env, () => options.createTransport === undefined
        ? new HttpTransport({ baseUrl: controller.baseUrl, apiBasePath: "/", verifySsl: controller.verifySsl, readOnly: true, attempts: 1, signal: homeCancellation!.signal })
        : options.createTransport(env, homeCancellation!.signal));
      home = await homeCommand(context, bareHome ? env : {}, metadata.release);
    } catch (error) {
      (options.stdout ?? process.stdout).write(redact(homeDiagnostic(error, selection)));
      process.exitCode = 0;
      return;
    } finally {
      clearTimeout(deadline);
      homeCancellation!.abort();
    }
  }

  await runAxiCli({
    argv,
    stdout: { write: (chunk) => (options.stdout ?? process.stdout).write(redact(chunk)) },
    description: DESCRIPTION,
    version: readPackageVersion(),
    topLevelHelp: topLevelHelp(),
    commands,
    // `exitCodeForError` maps only the literal `VALIDATION_ERROR` to 2, and
    // three other codes must also exit 2 (§9).
    formatError,
    renderUnknownCommand: (command) =>
      `${encode({
        error: `Unknown command: ${command}`,
        code: "VALIDATION_ERROR",
        help: ["Run `awx-axi --help` to see available commands"],
      })}\n`,
    getCommandHelp: (command) => {
      if (command === "auth") {
        return AUTH_HELP;
      }
      if (command === "setup") {
        return SETUP_HELP;
      }
      if (command === "doctor") return "usage: awx-axi doctor [--config <path>] [--profile <name>]\nVerify credential permissions and read the selected controller identity once.\n";
      if (command === "config") return "usage: awx-axi config path [--config <path>]\nPrint the selected config path without reading secrets.\n";
      if (command === "profile") return "usage: awx-axi profile list [--config <path>]\nList configured profile names and origins without resolving secrets.\n";
      const domain = DOMAINS.find((candidate) => candidate.name === command);
      const help =
        domain?.subcommands.find((subcommand) => subcommand.name === argv[1])
          ?.help ?? domain?.help;
      return help === undefined || help.endsWith("\n") ? help : `${help}\n`;
    },
    home: () => home!,
  });
}

/** One registered command per domain entry, plus the core commands. */
function buildCommands(
  context: DomainContext & AuthContext,
): Record<string, AxiCliCommand<undefined>> {
  const commands: Record<string, AxiCliCommand<undefined>> = {
    auth: (args) => authCommand(args, context),
    doctor: (args) => authCommand(["status", ...args], context),
    setup: (args) => setupCommand(args),
    config: (args) => {
      if (args.length !== 1 || args[0] !== "path") throw validationError("usage: awx-axi config path [--config <path>]");
      return { config: configPath(context.env, context.selection) };
    },
    profile: (args) => {
      if (args.length !== 1 || args[0] !== "list") throw validationError("usage: awx-axi profile list [--config <path>]");
      const config = loadConfig(context.env, context.selection);
      return { profiles: Object.entries(config.profiles).map(([name, profile]) => ({ name, origin: profile.origin, default: name === config.defaultProfile })) };
    },
  };
  for (const domain of DOMAINS) {
    commands[domain.name] = async (args) => {
      // `runAxiCli` sets a non-zero exit code only from a thrown error, and
      // §7.9's `job watch` must exit 1 while still rendering the job block. The
      // exit code is applied here, where the handler's value is returned to the
      // loop, so the core owns it rather than each domain (§10.2).
      const { output, exitCode } = splitResult(await domain.run(args, context));
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
      return output;
    };
  }
  return commands;
}

function topLevelHelp(): string {
  return `${encode({
    bin: "awx-axi",
    description: DESCRIPTION,
    usage: "awx-axi <command> [args] [flags]",
    commands: "auth, profile list, config path, doctor, setup",
    globals: "--config <path>, --profile <name>, --origin <origin>, --verify-ssl <true|false>",
    domains:
      DOMAINS.length === 0
        ? "none yet: this build is the core"
        : DOMAINS.map((domain) => domain.name).join(", "),
  })}\n`;
}

function readPackageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (parsed as { version: string }).version;
  } catch {
    return "0.1.0";
  }
}
