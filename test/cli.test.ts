import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DESCRIPTION, DOMAINS, main } from "../src/cli.js";
import type { Domain } from "../src/core/registry.js";

function capture(): { write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(""),
  };
}

describe("the CLI shell", () => {
  it.each([
    { name: "Codex missing", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: true },
    { name: "Codex global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.agents/skills", hint: false },
    { name: "Codex project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.agents/skills", hint: false },
    { name: "Claude missing", env: { CLAUDECODE: "1" }, installed: undefined, hint: true },
    { name: "Claude global", env: { CLAUDECODE: "1" }, installed: "home/.claude/skills", hint: false },
    { name: "Claude shared global", env: { CLAUDECODE: "1" }, installed: "home/.agents/skills", hint: false },
    { name: "Claude project", env: { CLAUDECODE: "1" }, installed: "repo/.claude/skills", hint: false },
    { name: "Claude shared project", env: { CLAUDECODE: "1" }, installed: "repo/.agents/skills", hint: false },
    { name: "Claude custom global", env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "custom" }, installed: "custom/skills", hint: false },
    { name: "OpenCode missing", env: { OPENCODE: "1" }, installed: undefined, hint: true },
    { name: "OpenCode shared global", env: { OPENCODE: "1" }, installed: "home/.agents/skills", hint: false },
    { name: "OpenCode project", env: { OPENCODE: "1" }, installed: "repo/.agents/skills", hint: false },
    { name: "Pi missing", env: { PI_SESSION_ID: "session" }, installed: undefined, hint: true },
    { name: "Pi global", env: { PI_SESSION_ID: "session" }, installed: "home/.agents/skills", hint: false },
    { name: "Pi project", env: { PI_SESSION_ID: "session" }, installed: "repo/.agents/skills", hint: false },
    { name: "no host", env: {}, installed: undefined, hint: false },
    { name: "another host's install", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.claude/skills", hint: true },
    { name: "outside repository", env: { CODEX_THREAD_ID: "thread" }, installed: ".agents/skills", hint: true },
    { name: "current directory", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/nested/.agents/skills", hint: false },
    { name: "help stays unchanged", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: false, argv: ["--help"] },
    { name: "version stays unchanged", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: false, argv: ["--version"] },
    { name: "command stays unchanged", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: false, argv: ["config", "path"] },
    { name: "global flags stay unchanged", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: false, argv: ["--profile", "default"] },
  ])("shows the skill hint only when needed: $name", async ({ env, installed, hint, ...testCase }) => {
    const root = mkdtempSync(resolve("node_modules/awx-axi-home-test-"));
    const cwd = join(root, "repo/nested");
    const home = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home);
    // A worktree's .git entry is a file, not a directory.
    writeFileSync(join(root, "repo/.git"), "gitdir: unused");
    if (installed !== undefined) {
      const directory = join(root, installed, "awx-axi");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), "installed skill");
    }
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      const stdout = capture();
      await main({
        argv: "argv" in testCase ? testCase.argv : [],
        stdout,
        env: {
          ...env,
          HOME: home,
          ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: join(root, env.CLAUDE_CONFIG_DIR) } : {}),
        },
      });
      const command = "npx skills add knowttl/awx-axi --skill awx-axi";
      expect(stdout.text().includes(command)).toBe(hint);
      if (hint) expect(stdout.text().match(/npx skills add/g)).toHaveLength(1);
      if (!("argv" in testCase)) {
        expect(stdout.text()).toContain(`help[${hint ? 3 : 2}]:`);
        expect(stdout.text()).toContain("Run `awx-axi auth status` to check the configured controller");
      } else {
        const baseline = capture();
        await main({ argv: testCase.argv, stdout: baseline, env: { HOME: home } });
        expect(stdout.text()).toBe(baseline.text());
      }
    } finally {
      cwdSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still renders home when the working directory cannot be read", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("working directory removed");
    });
    const previousExitCode = process.exitCode;
    try {
      const stdout = capture();
      await main({ argv: [], stdout, env: { CODEX_THREAD_ID: "thread", HOME: "/missing-awx-axi-test-home" } });
      expect(stdout.text()).toContain("help[2]:");
      expect(process.exitCode).toBe(previousExitCode);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("renders the top-level help for --help", async () => {
    const stdout = capture();

    await main({ argv: ["--help"], stdout, env: {} });

    expect(stdout.text()).toContain(`description: ${DESCRIPTION}`);
    expect(stdout.text()).toContain("awx-axi <command> [args] [flags]");
    expect(stdout.text()).toContain(
      "domains: \"job, template, workflow, organization, system-job-template, system-job, credential, approval, ad-hoc, project, inventory, host, group, inventory-source, schedule, execution-environment, user, notification, notification-template, activity-stream, team, role\"",
    );
    expect(stdout.text()).toContain('commands: "auth, profile list, config path, doctor, setup"');
  });

  it("renders the version for --version", async () => {
    const stdout = capture();

    await main({ argv: ["--version"], stdout, env: {} });

    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("renders subcommand help and falls back to noun help", async () => {
    const domains = DOMAINS as Domain[];
    domains.push({
      name: "widget",
      help: "widget help",
      subcommands: [
        {
          name: "list",
          help: "widget list help",
          flags: [],
          positionals: { names: [], required: 0 },
          schema: { label: "widgets", defaultFields: [], fieldAllowlist: [] },
          suggestions: [],
          // eslint-disable-next-line require-yield
          plan: function* () {
            return {};
          },
        },
      ],
      mcpEquivalents: [],
      run: () => Promise.resolve({}),
    });

    try {
      const subcommandStdout = capture();
      await main({
        argv: ["widget", "list", "--help"],
        stdout: subcommandStdout,
        env: {},
      });
      expect(subcommandStdout.text()).toContain("widget list help");

      const nounStdout = capture();
      await main({
        argv: ["widget", "unknown", "--help"],
        stdout: nounStdout,
        env: {},
      });
      expect(nounStdout.text()).toContain("widget help");
    } finally {
      domains.pop();
    }
  });

  it("terminates per-domain help with a newline", async () => {
    const stdout = capture();
    await main({ argv: ["organization", "list", "--help"], stdout, env: {} });
    expect(stdout.text().endsWith("\n")).toBe(true);
  });

  it("gives a complete help command for an unknown command", async () => {
    const stdout = capture();
    const previousExitCode = process.exitCode;

    try {
      await main({ argv: ["unknowncmd"], stdout, env: {} });

      expect(process.exitCode).toBe(2);
      expect(stdout.text()).toContain('error: "Unknown command: unknowncmd"');
      expect(stdout.text()).toContain("code: VALIDATION_ERROR");
      expect(stdout.text()).toContain(
        "help[1]: Run `awx-axi --help` to see available commands",
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("registers the notification domains", () => {
    const names = DOMAINS.map((domain) => domain.name);

    expect(names).toContain("approval");
    expect(names).toContain("schedule");
    expect(names).toContain("execution-environment");
    expect(names).toContain("organization");
    expect(names).toContain("credential");
    expect(names).toContain("user");
    expect(names).toContain("notification");
    expect(names).toContain("notification-template");
    expect(names).toContain("activity-stream");
  });

  it("registers the inventory domain", () => {
    expect(DOMAINS.map((domain) => domain.name)).toContain("system-job-template");
    expect(DOMAINS.map((domain) => domain.name)).toContain("system-job");
    expect(DOMAINS.map((domain) => domain.name)).toContain("inventory");
    expect(DOMAINS.map((domain) => domain.name)).toContain("group");
    expect(DOMAINS.map((domain) => domain.name)).toContain("inventory-source");
  });

  it("registers the identity and RBAC domains", () => {
    expect(DOMAINS.map((domain) => domain.name)).toContain("organization");
    expect(DOMAINS.map((domain) => domain.name)).toContain("credential");
    expect(DOMAINS.map((domain) => domain.name)).toContain("user");
    expect(DOMAINS.map((domain) => domain.name)).toContain("team");
    expect(DOMAINS.map((domain) => domain.name)).toContain("role");
  });
});
