import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { SETUP_HELP, setupCommand } from "../src/commands/setup.js";

describe("setup command (design.md §13)", () => {
  it.each([
    { args: [], message: "`awx-axi setup` needs a subcommand" },
    { args: ["invalid"], message: "unknown subcommand `setup invalid`" },
  ])("rejects invalid subcommands: $args", async ({ args, message }) => {
    await expect(setupCommand(args)).rejects.toMatchObject({ code: "VALIDATION_ERROR", message });
  });

  it("installs the bare dashboard command for session start in a temporary home", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "awx-axi-setup-test-"));
    const execPath = resolve(import.meta.dirname, "../dist/bin/awx-axi.js");
    try {
      expect(await setupCommand(["hooks"], { homeDir, execPath })).toEqual({
        setup: { hooks: "installed session-start hooks for Claude Code, Codex, and OpenCode" },
      });
      const settings = JSON.parse(readFileSync(join(homeDir, ".claude/settings.json"), "utf8")) as {
        hooks: { SessionStart: { hooks: { command: string }[] }[] };
      };
      expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(execPath);
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it("renders setup hooks output via CLI main using the supplied home", async () => {
    const home = mkdtempSync(join(tmpdir(), "awx-axi-setup-cli-test-"));
    let text = "";
    try {
      await main({ argv: ["setup", "hooks"], stdout: { write: (chunk) => { text += chunk; } }, env: { HOME: home } });
      expect(text).toContain("installed session-start hooks for Claude Code, Codex, and OpenCode");
      const settings = JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8")) as {
        hooks: { SessionStart: { hooks: { command: string }[] }[] };
      };
      expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(process.argv[1]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("renders help text for setup command", async () => {
    let text = "";
    await main({ argv: ["setup", "--help"], stdout: { write: (chunk) => { text += chunk; } }, env: {} });
    expect(text).toContain(SETUP_HELP);
  });
});
