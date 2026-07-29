/**
 * `setup hooks` (design.md §13).
 *
 * Install session-start hooks for Claude Code, Codex, and OpenCode.
 */
import { installSessionStartHooks } from "axi-sdk-js";

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
  readonly installHooks?: () => void;
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

  const install = options.installHooks ?? installSessionStartHooks;
  install();

  return {
    setup: {
      hooks: "installed session-start hooks for Claude Code, Codex, and OpenCode",
    },
  };
}
