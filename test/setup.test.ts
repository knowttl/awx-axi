import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { SETUP_HELP, setupCommand } from "../src/commands/setup.js";

function capture(): { write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(""),
  };
}

describe("setup command (design.md §13)", () => {
  it("executes setup hooks via setupCommand", async () => {
    const installHooks = vi.fn();
    const result = await setupCommand(["hooks"], { installHooks });

    expect(installHooks).toHaveBeenCalledOnce();
    expect(result).toEqual({
      setup: {
        hooks:
          "installed session-start hooks for Claude Code, Codex, and OpenCode",
      },
    });
  });

  it("throws a validation error when no subcommand is provided", async () => {
    await expect(setupCommand([])).rejects.toThrow(AxiError);
    await expect(setupCommand([])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "`awx-axi setup` needs a subcommand",
    });
  });

  it("throws a validation error when an unknown subcommand is provided", async () => {
    await expect(setupCommand(["invalid"])).rejects.toThrow(AxiError);
    await expect(setupCommand(["invalid"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "unknown subcommand `setup invalid`",
    });
  });

  it("executes real installSessionStartHooks default without crashing in temporary home", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "awx-axi-setup-test-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const result = await setupCommand(["hooks"]);
      expect(result).toEqual({
        setup: {
          hooks:
            "installed session-start hooks for Claude Code, Codex, and OpenCode",
        },
      });
    } finally {
      process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("renders setup hooks output via CLI main", async () => {
    const stdout = capture();
    const tempHome = mkdtempSync(join(tmpdir(), "awx-axi-setup-cli-test-"));

    await main({
      argv: ["setup", "hooks"],
      stdout,
      env: { HOME: tempHome },
    });

    expect(stdout.text()).toContain(
      "installed session-start hooks for Claude Code, Codex, and OpenCode",
    );

    rmSync(tempHome, { recursive: true, force: true });
  });

  it("renders help text for setup command", async () => {
    const stdout = capture();

    await main({
      argv: ["setup", "--help"],
      stdout,
      env: {},
    });

    expect(stdout.text()).toContain(SETUP_HELP);
  });
});
