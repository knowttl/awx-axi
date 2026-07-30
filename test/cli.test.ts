import { describe, expect, it } from "vitest";

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
  it("renders the top-level help for --help", async () => {
    const stdout = capture();

    await main({ argv: ["--help"], stdout, env: {} });

    expect(stdout.text()).toContain(`description: ${DESCRIPTION}`);
    expect(stdout.text()).toContain("awx-axi <command> [args] [flags]");
    expect(stdout.text()).toContain(
      "domains: \"job, template, workflow, organization, system-job-template, system-job, credential, approval, ad-hoc, project, inventory, schedule, execution-environment, user\"",
    );
    expect(stdout.text()).toContain('commands: "auth, setup"');
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

  it("registers the approval domain", () => {
    expect(DOMAINS.map((domain) => domain.name)).toContain("approval");
    expect(DOMAINS.map((domain) => domain.name)).toContain("schedule");
    expect(DOMAINS.map((domain) => domain.name)).toContain(
      "execution-environment",
    );
    expect(DOMAINS.map((domain) => domain.name)).toContain("organization");
    expect(DOMAINS.map((domain) => domain.name)).toContain("credential");
    expect(DOMAINS.map((domain) => domain.name)).toContain("user");
  });

  it("registers the inventory domain", () => {
    expect(DOMAINS.map((domain) => domain.name)).toContain("system-job-template");
    expect(DOMAINS.map((domain) => domain.name)).toContain("system-job");
    expect(DOMAINS.map((domain) => domain.name)).toContain("inventory");
  });

  it("registers the identity domains", () => {
    expect(DOMAINS.map((domain) => domain.name)).toContain("organization");
    expect(DOMAINS.map((domain) => domain.name)).toContain("credential");
    expect(DOMAINS.map((domain) => domain.name)).toContain("user");
  });
});
