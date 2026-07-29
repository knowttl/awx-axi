/**
 * `setup hooks` (design.md §13).
 *
 * Install session-start hooks for Claude Code, Codex, and OpenCode.
 */
import { installSessionStartHooks } from "axi-sdk-js";

import type { Env } from "../core/auth.js";
import { validationError } from "../core/errors.js";
import { parseFlags } from "../core/flags.js";
import type { Renderable } from "../core/registry.js";

export const SETUP_HELP = `setup: configure shell and agent integrations
usage: awx-axi setup hooks

  hooks    install session-start hooks for Claude Code, Codex, and OpenCode

examples:
  awx-axi setup hooks
`;

const SUBCOMMANDS = ["hooks"];

export interface SetupOptions {
  /** Optional test seam for the side-effectful install function. */
  readonly installHooks?: () => void;
  /** Execution context used to resolve a non-default home directory. */
  readonly env?: Env;
}

export async function setupCommand(
  args: string[],
  options: SetupOptions = {},
): Promise<Renderable> {
  const name = args[0];
  if (name === undefined || !SUBCOMMANDS.includes(name)) {
    throw validationError(
      name === undefined
        ? "`awx-axi setup` needs a subcommand"
        : `unknown subcommand \`setup ${name}\``,
      [`valid subcommands for \`awx-axi setup\`: ${SUBCOMMANDS.join(", ")}`],
    );
  }

  parseFlags(`setup ${name}`, args.slice(1), [], {
    names: [],
    required: 0,
  });

  if (options.installHooks === undefined) {
    const homeDir = options.env?.HOME;
    if (homeDir === undefined) {
      installSessionStartHooks();
    } else {
      installSessionStartHooks({ homeDir });
    }
  } else {
    options.installHooks();
  }

  return {
    setup: {
      hooks: "installed session-start hooks for Claude Code, Codex, and OpenCode",
    },
  };
}
