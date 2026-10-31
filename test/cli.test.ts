import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join, resolve, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DESCRIPTION, DOMAINS, main } from "../src/cli.js";
import type { Domain } from "../src/core/registry.js";
import { HttpTransport, RecordedTransport } from "../src/core/transport.js";
import { exchange, fixtureFetch } from "./support/fixtures.js";

vi.mock("node:fs", { spy: true });

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
  it("reports an HTML login page as INVALID_RESPONSE on stdout with exit 1", async () => {
    const stdout = capture();
    const previousExitCode = process.exitCode;
    const { fetch } = fixtureFetch(["login-page"]);
    try {
      await main({
        argv: ["template", "list"], stdout, env: {},
        createTransport: () => new HttpTransport({
          baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: true, fetch,
        }),
      });
      expect(process.exitCode).toBe(1);
      expect(stdout.text()).toBe("error: the controller returned a non-JSON response\ncode: INVALID_RESPONSE\nstatus: 200\ncontentType: text/plain\nshape[1]{path,type}:\n  $,string\nshapeTruncated: false\n");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("retains safe diagnostics when collection validation fails after the HTTP read", async () => {
    const stdout = capture();
    const previousExitCode = process.exitCode;
    const { fetch } = fixtureFetch(["invalid-list-envelope"]);
    try {
      await main({
        argv: ["template", "list"], stdout, env: {},
        createTransport: (_env, _signal, diagnostics) => new HttpTransport({
          baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: true, fetch,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        }),
      });
      expect(process.exitCode).toBe(1);
      expect(stdout.text()).toBe('error: the controller returned a list page with no results\ncode: INVALID_RESPONSE\nstatus: 200\ncontentType: application/json\nshape[3]{path,type}:\n  $,object\n  "$[\\"results\\"]",string\n  "$[\\"<key>\\"]",string\nshapeTruncated: false\n');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    { name: "Codex missing", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, hint: true },
    { name: "Codex global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.agents/skills", hint: false },
    { name: "Codex project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.agents/skills", hint: false },
    { name: "Codex native global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.codex/skills", hint: false },
    { name: "Codex custom native global", env: { CODEX_THREAD_ID: "thread", CODEX_HOME: "custom" }, installed: "custom/skills", hint: false },
    { name: "Codex bundled system", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.codex/skills/.system", hint: false },
    { name: "Codex custom bundled system", env: { CODEX_THREAD_ID: "thread", CODEX_HOME: "custom" }, installed: "custom/skills/.system", hint: false },
    { name: "Codex admin", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, systemSkill: "/etc/codex/skills/awx-axi/SKILL.md", hint: false },
    { name: "Codex custom home replaces native default", env: { CODEX_THREAD_ID: "thread", CODEX_HOME: "custom" }, installed: "home/.codex/skills", hint: true },
    { name: "Claude missing", env: { CLAUDECODE: "1" }, installed: undefined, hint: true },
    { name: "Claude global", env: { CLAUDECODE: "1" }, installed: "home/.claude/skills", hint: false },
    { name: "Codex-only global install in Claude", env: { CLAUDECODE: "1" }, installed: "home/.agents/skills", hint: true },
    { name: "Claude project", env: { CLAUDECODE: "1" }, installed: "repo/.claude/skills", hint: false },
    { name: "Claude current directory", env: { CLAUDECODE: "1" }, installed: "repo/nested/.claude/skills", hint: false },
    { name: "Claude does not load descendants at startup", env: { CLAUDECODE: "1" }, installed: "repo/nested/child/.claude/skills", hint: true },
    { name: "Claude stops at repository root", env: { CLAUDECODE: "1" }, installed: ".claude/skills", hint: true },
    { name: "Codex-only project install in Claude", env: { CLAUDECODE: "1" }, installed: "repo/.agents/skills", hint: true },
    { name: "Claude custom global", env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "custom" }, installed: "custom/skills", hint: false },
    { name: "Claude custom home replaces native default", env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "custom" }, installed: "home/.claude/skills", hint: true },
    {
      name: "Claude managed enterprise", env: { CLAUDECODE: "1" }, installed: undefined, hint: false,
      systemSkill: join(process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
        : process.platform === "win32" ? join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode")
        : "/etc/claude-code", ".claude/skills/awx-axi/SKILL.md"),
    },
    { name: "Claude ignores Codex admin", env: { CLAUDECODE: "1" }, installed: undefined, systemSkill: "/etc/codex/skills/awx-axi/SKILL.md", hint: true },
    { name: "Claude ignores OpenCode global", env: { CLAUDECODE: "1" }, installed: "home/.config/opencode/skills", hint: true },
    { name: "Claude ignores OpenCode project", env: { CLAUDECODE: "1" }, installed: "repo/.opencode/skills", hint: true },
    { name: "Claude ignores Pi global", env: { CLAUDECODE: "1" }, installed: "home/.pi/agent/skills", hint: true },
    { name: "Claude ignores Pi project", env: { CLAUDECODE: "1" }, installed: "repo/.pi/skills", hint: true },
    { name: "Claude main checkout with relative metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "relative", hint: false },
    { name: "Claude main checkout with absolute metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "absolute", hint: false },
    { name: "Claude main checkout with absolute git pointer", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "absolute-pointer", hint: false },
    { name: "Claude main checkout with absolute common directory", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "absolute-common", hint: false },
    { name: "Claude empty local root blocks main checkout", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "local-root", hint: true },
    { name: "Claude installed local root", env: { CLAUDECODE: "1" }, installed: "repo/.claude/skills", worktree: "relative", hint: false },
    { name: "Claude nested install with empty local root", env: { CLAUDECODE: "1" }, installed: "repo/nested/.claude/skills", worktree: "local-root", hint: false },
    { name: "Claude missing common directory metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "missing-common", hint: true },
    { name: "Claude empty common directory metadata", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "empty-common", hint: true },
    { name: "Claude invalid git pointer", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "invalid-pointer", hint: true },
    { name: "Claude main checkout without skill", env: { CLAUDECODE: "1" }, installed: undefined, worktree: "missing-skill", hint: true },
    { name: "Codex ignores Claude main checkout", env: { CODEX_THREAD_ID: "thread" }, installed: undefined, worktree: "relative", hint: true },
    { name: "OpenCode ignores Claude main checkout", env: { OPENCODE: "1" }, installed: undefined, worktree: "relative", hint: true },
    { name: "Pi ignores Claude main checkout", env: { PI_SESSION_ID: "session" }, installed: undefined, worktree: "relative", hint: true },
    { name: "OpenCode missing", env: { OPENCODE: "1" }, installed: undefined, hint: true },
    { name: "OpenCode shared global", env: { OPENCODE: "1" }, installed: "home/.agents/skills", hint: false },
    { name: "OpenCode project", env: { OPENCODE: "1" }, installed: "repo/.agents/skills", hint: false },
    { name: "OpenCode shared current directory", env: { OPENCODE: "1" }, installed: "repo/nested/.agents/skills", hint: false },
    { name: "OpenCode stops at repository root", env: { OPENCODE: "1" }, installed: ".opencode/skills", hint: true },
    { name: "OpenCode native global", env: { OPENCODE: "1" }, installed: "home/.config/opencode/skills", hint: false },
    { name: "OpenCode XDG global", env: { OPENCODE: "1", XDG_CONFIG_HOME: "custom" }, installed: "custom/opencode/skills", hint: false },
    { name: "OpenCode config directory", env: { OPENCODE: "1", OPENCODE_CONFIG_DIR: "custom" }, installed: "custom/skills", hint: false },
    { name: "OpenCode config directory keeps global roots", env: { OPENCODE: "1", OPENCODE_CONFIG_DIR: "custom" }, installed: "home/.config/opencode/skills", hint: false },
    { name: "OpenCode native project", env: { OPENCODE: "1" }, installed: "repo/.opencode/skills", hint: false },
    { name: "OpenCode native current directory", env: { OPENCODE: "1" }, installed: "repo/nested/.opencode/skills", hint: false },
    { name: "OpenCode Claude global", env: { OPENCODE: "1" }, installed: "home/.claude/skills", hint: false },
    { name: "OpenCode Claude project", env: { OPENCODE: "1" }, installed: "repo/.claude/skills", hint: false },
    { name: "OpenCode Claude current directory", env: { OPENCODE: "1" }, installed: "repo/nested/.claude/skills", hint: false },
    { name: "OpenCode ignores Codex native global", env: { OPENCODE: "1" }, installed: "home/.codex/skills", hint: true },
    { name: "OpenCode ignores Pi global", env: { OPENCODE: "1" }, installed: "home/.pi/agent/skills", hint: true },
    { name: "OpenCode ignores Pi project", env: { OPENCODE: "1" }, installed: "repo/.pi/skills", hint: true },
    { name: "Pi missing", env: { PI_SESSION_ID: "session" }, installed: undefined, hint: true },
    { name: "Pi global", env: { PI_SESSION_ID: "session" }, installed: "home/.agents/skills", hint: false },
    { name: "Pi project", env: { PI_SESSION_ID: "session" }, installed: "repo/.agents/skills", hint: false },
    { name: "Pi shared current directory", env: { PI_SESSION_ID: "session" }, installed: "repo/nested/.agents/skills", hint: false },
    { name: "Pi stops at repository root", env: { PI_SESSION_ID: "session" }, installed: ".agents/skills", hint: true },
    { name: "Pi native global", env: { PI_SESSION_ID: "session" }, installed: "home/.pi/agent/skills", hint: false },
    { name: "Pi native current directory", env: { PI_SESSION_ID: "session" }, installed: "repo/nested/.pi/skills", hint: false },
    { name: "Pi native ancestor is not loaded", env: { PI_SESSION_ID: "session" }, installed: "repo/.pi/skills", hint: true },
    { name: "Pi custom native global", env: { PI_SESSION_ID: "session", PI_CODING_AGENT_DIR: "custom" }, installed: "custom/skills", hint: false },
    { name: "Pi tilde native global", env: { PI_SESSION_ID: "session", PI_CODING_AGENT_DIR: "~/pi-custom" }, installed: "home/pi-custom/skills", hint: false },
    { name: "Pi custom home replaces native default", env: { PI_SESSION_ID: "session", PI_CODING_AGENT_DIR: "custom" }, installed: "home/.pi/agent/skills", hint: true },
    { name: "Pi ignores Codex native global", env: { PI_SESSION_ID: "session" }, installed: "home/.codex/skills", hint: true },
    { name: "Pi ignores Claude global", env: { PI_SESSION_ID: "session" }, installed: "home/.claude/skills", hint: true },
    { name: "Pi ignores Claude project", env: { PI_SESSION_ID: "session" }, installed: "repo/.claude/skills", hint: true },
    { name: "Pi ignores OpenCode global", env: { PI_SESSION_ID: "session" }, installed: "home/.config/opencode/skills", hint: true },
    { name: "Pi ignores OpenCode project", env: { PI_SESSION_ID: "session" }, installed: "repo/.opencode/skills", hint: true },
    { name: "no host", env: {}, installed: undefined, hint: false },
    { name: "another host's install", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.claude/skills", hint: true },
    { name: "Codex ignores Claude project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.claude/skills", hint: true },
    { name: "Codex ignores OpenCode global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.config/opencode/skills", hint: true },
    { name: "Codex ignores OpenCode project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.opencode/skills", hint: true },
    { name: "Codex ignores Pi global", env: { CODEX_THREAD_ID: "thread" }, installed: "home/.pi/agent/skills", hint: true },
    { name: "Codex ignores Pi project", env: { CODEX_THREAD_ID: "thread" }, installed: "repo/.pi/skills", hint: true },
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
    if ("worktree" in testCase) {
      const gitDirectory = join(root, "main/.git/worktrees/linked");
      mkdirSync(gitDirectory, { recursive: true });
      writeFileSync(join(root, "repo/.git"), testCase.worktree === "invalid-pointer" ? "invalid"
        : `gitdir: ${testCase.worktree === "absolute" || testCase.worktree === "absolute-pointer"
          ? gitDirectory : "../main/.git/worktrees/linked"}\n`);
      if (testCase.worktree !== "missing-common") {
        writeFileSync(join(gitDirectory, "commondir"), testCase.worktree === "empty-common" ? "\n"
          : `${testCase.worktree === "absolute" || testCase.worktree === "absolute-common"
            ? join(root, "main/.git") : "../.."}\n`);
      }
      if (testCase.worktree !== "missing-skill") {
        const directory = join(root, "main/.claude/skills/awx-axi");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "SKILL.md"), "installed skill");
      }
      if (testCase.worktree === "local-root") mkdirSync(join(root, "repo/.claude/skills"), { recursive: true });
    }
    if (installed !== undefined) {
      const directory = join(root, installed, "awx-axi");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), "installed skill");
    }
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const pathExists = fs.existsSync;
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((path) => {
      if (typeof path === "string" && !path.startsWith(`${root}${sep}`)) {
        return "systemSkill" in testCase && path === testCase.systemSkill;
      }
      return pathExists(path);
    });
    try {
      const stdout = capture();
      const transport = new RecordedTransport([
        exchange("controller-api-root"), exchange("controller-ping"),
        { status: 200, body: { count: 0, results: [] } },
        { status: 200, body: { count: 0, results: [] } },
        { status: 200, body: { count: 0, results: [] } },
      ]);
      await main({
        argv: "argv" in testCase ? testCase.argv : [],
        stdout,
        createTransport: () => transport,
        env: {
          ...env,
          HOME: home,
          AWX_AXI_ORIGIN: "https://awx.example.com",
          AWX_AXI_TOKEN: "synthetic-test-token",
          ...(process.env.ProgramFiles ? { ProgramFiles: process.env.ProgramFiles } : {}),
          ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: join(root, env.CLAUDE_CONFIG_DIR) } : {}),
          ...(env.CODEX_HOME ? { CODEX_HOME: join(root, env.CODEX_HOME) } : {}),
          ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: join(root, env.XDG_CONFIG_HOME) } : {}),
          ...(env.OPENCODE_CONFIG_DIR ? { OPENCODE_CONFIG_DIR: join(root, env.OPENCODE_CONFIG_DIR) } : {}),
          ...(env.PI_CODING_AGENT_DIR ? {
            PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR.startsWith("~")
              ? env.PI_CODING_AGENT_DIR : join(root, env.PI_CODING_AGENT_DIR),
          } : {}),
        },
      });
      const command = "npx skills add knowttl/awx-axi --skill awx-axi";
      expect(stdout.text().includes(command)).toBe(hint);
      if (hint) expect(stdout.text().match(/npx skills add/g)).toHaveLength(1);
      if (!("argv" in testCase)) {
        expect(stdout.text()).toContain(`help[${hint ? 3 : 2}]:`);
        expect(stdout.text()).toContain("Run `awx-axi job list` for recent job history");
      } else {
        const baseline = capture();
        await main({ argv: testCase.argv, stdout: baseline, env: { HOME: home } });
        expect(stdout.text()).toBe(baseline.text());
      }
    } finally {
      existsSpy.mockRestore();
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
      expect(stdout.text()).toContain("awx: controller configuration required;");
      expect(process.exitCode).toBe(0);
    } finally {
      cwdSpy.mockRestore();
      process.exitCode = previousExitCode;
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
