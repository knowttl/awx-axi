/**
 * `setup hooks` (design.md §13).
 *
 * Install session-start hooks for Claude Code, Codex, and OpenCode.
 */
import { installSessionStartHooks } from "axi-sdk-js";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { AwxAxiError, validationError } from "../core/errors.js";
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
  readonly homeDir?: string | undefined;
  readonly execPath?: string;
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

  const home = options.homeDir ?? homedir();
  const execPath = resolve(options.execPath ?? process.argv[1]!);
  const targets = [
    { agent: "Claude Code", paths: [join(home, ".claude/settings.json")] },
    { agent: "Codex", paths: [join(home, ".codex/hooks.json"), join(home, ".codex/config.toml")] },
    { agent: "OpenCode", paths: [join(home, ".config/opencode/plugins/axi-awx-axi.js")] },
  ];
  const errors: string[] = [];
  installSessionStartHooks({
    homeDir: home,
    execPath,
    marker: "awx-axi",
    binaryNames: ["awx-axi"],
    shouldInstall: () => true,
    onError: (message) => { errors.push(message); },
  });

  const integrations = targets.map(({ agent, paths }) => {
    const failures = paths.flatMap((path) => {
      const error = errors.find((message) => message.startsWith(`${path}:`));
      // SDK JSON parse errors can include settings content. Report the affected
      // path and a safe correction, never the dependency's arbitrary message.
      if (error !== undefined) return [{ path, problem: error.endsWith("refusing to overwrite unmanaged OpenCode plugin")
        ? "unmanaged OpenCode plugin; move it aside before retrying"
        : "could not update configuration; check syntax and write permissions" }];
      try {
        const content = readFileSync(path, "utf8");
        const verified = path.endsWith(".json") ? verifyHookSettings(content, execPath)
          : path.endsWith(".toml") ? verifyCodexConfig(content)
          : content.startsWith("// axi-sdk-js managed opencode plugin: awx-axi\n")
            && verifyCommand(JSON.parse(/^const command = (.+);$/m.exec(content)?.[1] ?? "null") as unknown, execPath);
        if (verified) return [];
      } catch {
        // A missing or unreadable entry is an installation failure too.
      }
      return [{ path, problem: "installed entry could not be verified; repair configuration and retry" }];
    });
    return { agent, status: failures.length ? "failed" : "installed", paths, failures };
  });

  if (integrations.some((integration) => integration.status === "failed")) {
    const partial = integrations.some((integration) => integration.status === "installed");
    throw new AwxAxiError(
      partial ? "session-start hooks partially installed" : "session-start hook installation failed",
      "HOOK_INSTALL_FAILED",
      ["Repair the affected paths, then run `awx-axi setup hooks` again"],
      { setup: { hooks: partial ? "partial failure" : "failed", integrations } },
    );
  }

  return {
    setup: {
      hooks: "installed session-start hooks for Claude Code, Codex, and OpenCode",
    },
  };
}

function verifyHookSettings(content: string, execPath: string): boolean {
  const settings = JSON.parse(content) as { hooks?: { SessionStart?: { hooks?: { type?: string; command?: string; timeout?: number }[] }[] } };
  return settings.hooks?.SessionStart?.some((group) => group.hooks?.some((hook) =>
    hook.type === "command" && hook.timeout === 10 && verifyCommand(hook.command, execPath))) ?? false;
}

function verifyCommand(command: unknown, execPath: string): boolean {
  if (command === execPath) return true;
  if (command !== "awx-axi") return false;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try { return realpathSync(join(directory, command)) === realpathSync(execPath); } catch { /* Try the next PATH entry. */ }
  }
  return false;
}

function verifyCodexConfig(content: string): boolean {
  let inFeatures = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inFeatures = /^\s*\[features\]\s*(?:#.*)?$/.test(line);
    if (inFeatures && /^\s*hooks\s*=\s*true\s*(?:#.*)?$/.test(line)) return true;
  }
  return false;
}
