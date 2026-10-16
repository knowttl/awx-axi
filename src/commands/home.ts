import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Env } from "../core/auth.js";
import type { Renderable } from "../core/registry.js";

/**
 * Provisional home view until the live dashboard in design.md §8.1 is implemented.
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
  const host = env.CODEX_THREAD_ID ? "codex"
    : env.PI_SESSION_ID ? "pi"
    : env.OPENCODE === "1" ? "opencode"
    : env.CLAUDECODE === "1" ? "claude" : undefined;
  if (host === undefined) return false;

  try {
    const home = env.HOME || homedir();
    const skill = "awx-axi/SKILL.md";
    const { globalDirectories, projectDirectories } = {
      codex: {
        globalDirectories: [
          join(home, ".agents/skills"),
          join(env.CODEX_HOME?.trim() || join(home, ".codex"), "skills"),
        ],
        projectDirectories: [".agents/skills"],
      },
      claude: {
        globalDirectories: [join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills")],
        projectDirectories: [".claude/skills"],
      },
      opencode: {
        globalDirectories: [
          join(home, ".agents/skills"),
          join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode/skills"),
          join(home, ".claude/skills"),
        ],
        projectDirectories: [".agents/skills", ".opencode/skills", ".claude/skills"],
      },
      pi: {
        globalDirectories: [
          join(home, ".agents/skills"),
          join((env.PI_CODING_AGENT_DIR || join(home, ".pi/agent")).replace(/^~(?=\/|$)/, () => home), "skills"),
        ],
        projectDirectories: [".agents/skills", ".pi/skills"],
      },
    }[host];
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
