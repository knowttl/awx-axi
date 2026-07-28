import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { encode } from "@toon-format/toon";
import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";

import { homeCommand } from "./commands/home.js";
import type { Domain, DomainContext } from "./core/registry.js";

export const DESCRIPTION = "Inspect and run AWX automation from the shell";

/**
 * Noun to domain-module map (design.md §10.1).
 *
 * Empty in the scaffold: every domain is its own task. The list lives here
 * rather than in `core/registry.ts` because every domain imports the registry
 * for its contract types, so holding the list there would be a circular import.
 */
export const DOMAINS: readonly Domain[] = [];

export interface MainOptions {
  readonly argv?: string[];
  readonly stdout?: { write: (chunk: string) => unknown };
  readonly env?: Record<string, string | undefined>;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const context: DomainContext = { env: options.env ?? process.env };

  await runAxiCli({
    argv,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    description: DESCRIPTION,
    version: readPackageVersion(),
    topLevelHelp: topLevelHelp(),
    commands: buildCommands(context),
    renderUnknownCommand: (command) =>
      `${encode({
        error: `Unknown command: ${command}`,
        code: "VALIDATION_ERROR",
        help: ["Run `awx-axi --help` to see available commands"],
      })}\n`,
    getCommandHelp: (command) => {
      const domain = DOMAINS.find((candidate) => candidate.name === command);
      return (
        domain?.subcommands.find((subcommand) => subcommand.name === argv[1])
          ?.help ?? domain?.help
      );
    },
    home: () => homeCommand(),
  });
}

/** One registered command per domain entry. */
function buildCommands(
  context: DomainContext,
): Record<string, AxiCliCommand<undefined>> {
  const commands: Record<string, AxiCliCommand<undefined>> = {};
  for (const domain of DOMAINS) {
    commands[domain.name] = (args) => domain.run(args, context);
  }
  return commands;
}

function topLevelHelp(): string {
  return `${encode({
    bin: "awx-axi",
    description: DESCRIPTION,
    usage: "awx-axi <command> [args] [flags]",
    domains:
      DOMAINS.length === 0
        ? "none yet: this build is the scaffold"
        : DOMAINS.map((domain) => domain.name).join(", "),
  })}\n`;
}

function readPackageVersion(): string {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return (parsed as { version: string }).version;
}
