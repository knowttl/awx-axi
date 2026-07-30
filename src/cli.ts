import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { encode } from "@toon-format/toon";
import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";

import { AUTH_HELP, authCommand, type AuthContext } from "./commands/auth.js";
import { homeCommand } from "./commands/home.js";
import { SETUP_HELP, setupCommand } from "./commands/setup.js";
import {
  createBasicAuthTransport,
  createTransport,
  type Env,
} from "./core/auth.js";
import { formatError } from "./core/errors.js";
import {
  splitResult,
  type Domain,
  type DomainContext,
} from "./core/registry.js";
import type { AwxTransport } from "./core/transport.js";
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
import { userDomain } from "./domains/user/index.js";

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
  credentialDomain,
  approvalDomain,
  adHocDomain,
  projectDomain,
  inventoryDomain,
  scheduleDomain,
  executionEnvironmentDomain,
  userDomain,
];

export interface MainOptions {
  readonly argv?: string[];
  readonly stdout?: { write: (chunk: string) => unknown };
  readonly env?: Env;
  /** Injected offline by the test suite; `HttpTransport` in production. */
  readonly createTransport?: (env: Env) => AwxTransport;
  readonly createBasicAuthTransport?: (env: Env) => AwxTransport;
  /** Injected offline so `HttpTransport` in production. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const buildTransport = options.createTransport ?? createTransport;
  const buildBasicAuthTransport =
    options.createBasicAuthTransport ?? createBasicAuthTransport;

  const context: DomainContext & AuthContext = {
    env,
    createTransport: () => buildTransport(env),
    createBasicAuthTransport: () => buildBasicAuthTransport(env),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };

  await runAxiCli({
    argv,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    description: DESCRIPTION,
    version: readPackageVersion(),
    topLevelHelp: topLevelHelp(),
    commands: buildCommands(context),
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
      const domain = DOMAINS.find((candidate) => candidate.name === command);
      return (
        domain?.subcommands.find((subcommand) => subcommand.name === argv[1])
          ?.help ?? domain?.help
      );
    },
    home: () => homeCommand(),
  });
}

/** One registered command per domain entry, plus the core commands. */
function buildCommands(
  context: DomainContext & AuthContext,
): Record<string, AxiCliCommand<undefined>> {
  const commands: Record<string, AxiCliCommand<undefined>> = {
    auth: (args) => authCommand(args, context),
    setup: (args) => setupCommand(args, { env: context.env }),
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
    commands: "auth, setup",
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
