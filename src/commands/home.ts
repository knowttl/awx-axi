import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Env } from "../core/auth.js";
import type { Renderable } from "../core/registry.js";

/**
 * Provisional home view. The real §8.1 home view - what is running, what needs
 * a decision, what broke - is a later task, and inventing its output here would
 * be wrong. `runAxiCli` requires a home handler, so this one says plainly that
 * no domain is registered yet.
 *
 * The SDK merges the `bin:` and `description:` header into this output.
 */
export function homeCommand(env: Env): Renderable {
  return {
    awx: "core build: no AWX domain is registered yet",
    help: [
      "Run `awx-axi auth status` to check the configured controller",
      "Run `awx-axi --help` to see what this build provides",
      ...(needsSkillHint(env)
        ? ["Install the AWX skill: `npx skills add knowttl/awx-axi --skill awx-axi`"]
        : []),
    ],
  };
}

function needsSkillHint(env: Env): boolean {
  const sharedHost = env.CODEX_THREAD_ID || env.PI_SESSION_ID || env.OPENCODE === "1";
  const claude = !sharedHost && env.CLAUDECODE === "1";
  if (!sharedHost && !claude) return false;

  try {
    const home = env.HOME || homedir();
    const skill = "awx-axi/SKILL.md";
    const globalDirectories = [join(home, ".agents/skills")];
    const projectDirectories = [".agents/skills"];
    if (claude) {
      globalDirectories.push(join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills"));
      projectDirectories.push(".claude/skills");
    }
    if (globalDirectories.some((directory) => existsSync(join(directory, skill)))) return false;

    // Stop at .git files as well as directories, including disposable worktrees.
    for (let directory = process.cwd(); ; directory = dirname(directory)) {
      if (projectDirectories.some((path) => existsSync(join(directory, path, skill)))) return false;
      if (existsSync(join(directory, ".git")) || dirname(directory) === directory) break;
    }
    return true;
  } catch {
    // Discovery must never prevent the home view from rendering.
    return false;
  }
}
