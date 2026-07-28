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
      'domains: "none yet: this build is the scaffold"',
    );
  });

  it("renders the version for --version", async () => {
    const stdout = capture();

    await main({ argv: ["--version"], stdout, env: {} });

    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("renders subcommand help and falls back to noun help", async () => {
    const domains = DOMAINS as Domain[];
    domains.push({
      name: "job",
      help: "job help",
      subcommands: [
        {
          name: "list",
          help: "job list help",
          flags: [],
          schema: { label: "jobs", defaultFields: [], fieldAllowlist: [] },
          suggestions: [],
        },
      ],
      mcpEquivalents: [],
      run: () => Promise.resolve({}),
    });

    try {
      const subcommandStdout = capture();
      await main({
        argv: ["job", "list", "--help"],
        stdout: subcommandStdout,
        env: {},
      });
      expect(subcommandStdout.text()).toContain("job list help");

      const nounStdout = capture();
      await main({
        argv: ["job", "unknown", "--help"],
        stdout: nounStdout,
        env: {},
      });
      expect(nounStdout.text()).toContain("job help");
    } finally {
      domains.pop();
    }
  });

  it("gives a complete help command for an unknown command", async () => {
    const stdout = capture();
    const previousExitCode = process.exitCode;

    try {
      await main({ argv: ["job"], stdout, env: {} });

      expect(process.exitCode).toBe(2);
      expect(stdout.text()).toContain('error: "Unknown command: job"');
      expect(stdout.text()).toContain("code: VALIDATION_ERROR");
      expect(stdout.text()).toContain(
        "help[1]: Run `awx-axi --help` to see available commands",
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("registers no domains yet", () => {
    expect(DOMAINS).toHaveLength(0);
  });
});
