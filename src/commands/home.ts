import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AxiError } from "axi-sdk-js";

import { resolveController, type Env } from "../core/auth.js";
import { errorForResponse } from "../core/errors.js";
import type { Selection } from "../core/profiles.js";
import { read, runPlan, type DomainContext, type Plan } from "../core/registry.js";
import type { Query } from "../core/transport.js";

/**
 * Bounded session dashboard (design.md §8.1).
 * The SDK merges the `bin:` and `description:` header into this output.
 */
export async function homeCommand(
  context: DomainContext & { readonly selection?: Selection },
  hintEnv: Env,
): Promise<Record<string, unknown>> {
  const controller = resolveController(context.env, context.selection);
  const transport = context.createTransport();
  const now = Date.now();
  const [running, approvals, failures] = await Promise.all([
    runPlan(homeList("jobs/", { status__in: "new,pending,waiting,running", order_by: "-id" }, 5), { transport }),
    runPlan(homeList("workflow_approvals/", { status: "pending", order_by: "created" }, 5), { transport }),
    runPlan(homeList("jobs/", {
      status__in: "failed,error", finished__gte: new Date(now - 86_400_000).toISOString(), order_by: "-finished",
    }, 3), { transport }),
  ]);
  const help = [
    running.rows.length || failures.rows.length
      ? "Run `awx-axi job show <id>` for a job's result"
      : "Run `awx-axi job list` for recent job history",
    ...(approvals.rows.length ? ["Run `awx-axi approval show <id>` to see what it gates"] : []),
    "Run `awx-axi template list` to see what can be launched",
  ];
  for (const [label, list, command] of [
    ["running", running, "job list"],
    ["approvals", approvals, "approval list"],
    ["failures", failures, "job list --failed --since 24h"],
  ] as const) {
    if (list.count > list.rows.length) help.push(`Run \`awx-axi ${command}\` for more ${label} (${list.rows.length} of ${list.count} shown)`);
  }
  return {
    controller: controller.host,
    running: running.rows.length ? running.rows.map((row) => ({
      id: row.id, name: row.name, status: row.status, elapsed: row.elapsed,
    })) : "0 jobs running",
    approvals: approvals.rows.length ? approvals.rows.map((row) => ({
      id: row.id,
      workflow: ((row.summary_fields as Record<string, unknown> | undefined)?.source_workflow_job as Record<string, unknown> | undefined)?.name ?? null,
      waiting: typeof row.created === "string" && Number.isFinite(Date.parse(row.created))
        ? `${Math.max(0, Math.floor((now - Date.parse(row.created)) / 60_000))}m` : null,
    })) : "0 approvals pending",
    failures: failures.rows.length ? failures.rows.map((row) => ({
      id: row.id, name: row.name, status: row.status, finished: row.finished,
    })) : "0 failures in the last 24h",
    help: [
      ...help,
      ...(needsSkillHint(hintEnv)
        ? ["Install the AWX skill: `npx skills add knowttl/awx-axi --skill awx-axi`"]
        : []),
    ],
  };
}

function* homeList(path: string, query: Query, limit: number): Plan<{ rows: Record<string, unknown>[]; count: number }> {
  const response = yield* read(path, { ...query, page_size: limit });
  if (response.status !== 200) throw errorForResponse(response, { subject: "home dashboard" });
  const body = response.body as { results?: unknown; count?: unknown } | null;
  if (!body || !Array.isArray(body.results) || typeof body.count !== "number"
    || body.results.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    || (body.count > 0 && body.results.length === 0)) {
    throw new AxiError("invalid dashboard list response", "INVALID_RESPONSE");
  }
  // Do not follow `next`: each dashboard block has exactly one bounded read.
  return { rows: body.results.slice(0, limit) as Record<string, unknown>[], count: body.count };
}

/** Never expose controller response bodies or arbitrary exception text in session context. */
export function homeDiagnostic(error: unknown): string {
  const code = error instanceof AxiError ? error.code : "UNKNOWN";
  const problem = code === "AUTH_REQUIRED" ? "authentication required"
    : code === "FORBIDDEN" ? "dashboard access denied"
    : code === "CONTROLLER_UNREACHABLE" ? "controller unreachable"
    : code === "TLS_UNTRUSTED" ? "controller certificate could not be verified"
    : code.startsWith("PROFILE_") || code.startsWith("CONFIG_") ? "controller configuration required"
    : "dashboard unavailable";
  const fix = code === "AUTH_REQUIRED" ? "Run `awx-axi auth login` to configure credentials"
    : "Run `awx-axi auth status` to check configuration and access";
  return `awx: ${problem}; ${fix}\n`;
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
    const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
    const managedDirectory = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32" ? join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode")
      : "/etc/claude-code";
    // https://github.com/vercel-labs/skills/blob/main/src/agents.ts
    const roots: Record<typeof host, { path: string; scope: "user-system" | "cwd" | "ancestors" | "main-checkout" }[]> = {
      // https://developers.openai.com/codex/skills/#where-to-save-skills
      codex: [
        { path: join(home, ".agents/skills"), scope: "user-system" },
        { path: join(codexHome, "skills"), scope: "user-system" },
        { path: join(codexHome, "skills/.system"), scope: "user-system" },
        { path: "/etc/codex/skills", scope: "user-system" },
        { path: ".agents/skills", scope: "ancestors" },
      ],
      // https://code.claude.com/docs/en/skills#where-skills-live
      // https://code.claude.com/docs/en/managed-settings#delivery-mechanisms
      claude: [
        { path: join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills"), scope: "user-system" },
        { path: join(managedDirectory, ".claude/skills"), scope: "user-system" },
        { path: ".claude/skills", scope: "ancestors" },
        { path: ".claude/skills", scope: "main-checkout" },
      ],
      // https://opencode.ai/docs/skills/#place-files
      // https://opencode.ai/docs/config/#custom-directory
      opencode: [
        { path: join(home, ".agents/skills"), scope: "user-system" },
        { path: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode/skills"), scope: "user-system" },
        { path: join(home, ".claude/skills"), scope: "user-system" },
        ...(env.OPENCODE_CONFIG_DIR
          ? [{ path: join(env.OPENCODE_CONFIG_DIR, "skills"), scope: "user-system" as const }] : []),
        { path: ".agents/skills", scope: "ancestors" },
        { path: ".opencode/skills", scope: "ancestors" },
        { path: ".claude/skills", scope: "ancestors" },
      ],
      // https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/package-manager.ts
      pi: [
        { path: join(home, ".agents/skills"), scope: "user-system" },
        {
          path: join((env.PI_CODING_AGENT_DIR || join(home, ".pi/agent")).replace(/^~(?=\/|$)/, () => home), "skills"),
          scope: "user-system",
        },
        { path: ".agents/skills", scope: "ancestors" },
        { path: ".pi/skills", scope: "cwd" },
      ],
    };
    if (roots[host].some((root) => root.scope === "user-system" && existsSync(join(root.path, skill)))) return false;

    const cwd = process.cwd();
    // Stop at .git files as well as directories, including disposable worktrees.
    for (let directory = cwd; ; directory = dirname(directory)) {
      if (roots[host].some((root) => (root.scope === "ancestors" || (root.scope === "cwd" && directory === cwd))
        && existsSync(join(directory, root.path, skill)))) return false;
      if (existsSync(join(directory, ".git"))) {
        const fallbackRoots = roots[host].filter((root) => root.scope === "main-checkout"
          && !existsSync(join(directory, root.path)));
        if (fallbackRoots.length > 0) {
          const checkout = mainCheckout(directory);
          if (checkout && fallbackRoots.some((root) => existsSync(join(checkout, root.path, skill)))) return false;
        }
        break;
      }
      if (dirname(directory) === directory) break;
    }
    return true;
  } catch {
    // Discovery must never prevent the home view from rendering.
    return false;
  }
}

function mainCheckout(worktree: string): string | undefined {
  try {
    const pointer = /^gitdir:\s*(.+)$/.exec(readFileSync(join(worktree, ".git"), "utf8").trim());
    if (!pointer) return undefined;
    const gitDirectory = resolve(worktree, pointer[1]!);
    const commonDirectory = readFileSync(join(gitDirectory, "commondir"), "utf8").trim();
    return commonDirectory ? dirname(resolve(gitDirectory, commonDirectory)) : undefined;
  } catch {
    return undefined;
  }
}
