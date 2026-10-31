import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOMAINS } from "../src/cli.js";
import { loadFixture } from "./support/fixtures.js";

type PackResult = { filename: string; files: { path: string }[] };
type Result = { code: number; stdout: string; stderr: string };
const projectRoot = resolve(import.meta.dirname, "..");
let directory: string;
let bin: string;
let packed: PackResult;

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    OPENCODE_CONFIG_DIR: join(home, ".config/opencode"),
  };
}

function run(args: string[], home: string, extra: NodeJS.ProcessEnv = {}, executable = bin): Promise<Result> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd: home, env: { ...isolatedEnv(home), ...extra }, encoding: "utf8", timeout: 15_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

function identity(stdout: string): void {
  expect(stdout.split("\n").slice(0, 2)).toEqual([
    `bin: ${bin}`, "description: Inspect and run AWX automation from the shell",
  ]);
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function hookCommand(path: string): string {
  const settings = json(path) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
  return settings.hooks.SessionStart.flatMap((group) => group.hooks).find((hook) => hook.command.includes("awx-axi"))!.command;
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "awx-axi-package-"));
  [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: projectRoot, encoding: "utf8" })) as [PackResult];
  execFileSync("npm", ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { cwd: directory, encoding: "utf8" });
  bin = join(directory, "node_modules/.bin/awx-axi");
}, 60_000);

afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

describe("the installed package (issue #65)", () => {
  it("installs the executable and credential schema with the published identity", async () => {
    expect(packed.files.map((file) => file.path)).toEqual(expect.arrayContaining(["LICENSE", "dist/bin/awx-axi.js", "axi-credential.schema.json"]));
    const manifest = json(join(directory, "node_modules/awx-axi/package.json")) as { bin: Record<string, string>; repository: { url: string }; version: string };
    expect(manifest.repository.url).toBe("git+https://github.com/knowttl/awx-axi.git");
    expect(manifest.bin["awx-axi"]).toBe("dist/bin/awx-axi.js");
    expect(await run(["--version"], directory)).toEqual({ code: 0, stdout: `${manifest.version}\n`, stderr: "" });
    expect((await run(["--help"], directory)).stdout).toContain("description: Inspect and run AWX automation from the shell");
  });

  it("identifies itself before the missing-configuration diagnostic", async () => {
    const home = mkdtempSync(join(directory, "no-config-"));
    const result = await run([], home);
    expect(result.code).toBe(0);
    identity(result.stdout);
    expect(result.stdout).toContain("awx: controller configuration required;");
  });

  it.each([200, 401, 403])("identifies itself before the dashboard HTTP %s result", async (status) => {
    const home = mkdtempSync(join(directory, "http-error-"));
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      response.setHeader("content-type", "application/json");
      if (path === "/api/") response.end(JSON.stringify(loadFixture("controller-api-root").body));
      else if (path.endsWith("/ping/")) response.end(JSON.stringify(loadFixture("controller-ping").body));
      else if (status === 200) response.end(JSON.stringify(loadFixture(path.includes("workflow_approvals") ? "approval-list-pending" : "home-dashboard").body));
      else { response.statusCode = status; response.end(JSON.stringify({ detail: "synthetic-private-response" })); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const result = await run([], home, { AWX_AXI_ORIGIN: `http://127.0.0.1:${port}`, AWX_AXI_ALLOW_HTTP: "1", AWX_AXI_TOKEN: "synthetic-token" });
      expect(result.code).toBe(0);
      identity(result.stdout);
      if (status === 200) {
        expect(result.stdout).toContain("running[5]{id,name,status,elapsed}:");
        expect(result.stdout).toContain("approvals[2]{id,workflow,waiting}:");
        expect(result.stdout).toContain("failures[3]{id,name,status,finished}:");
      } else expect(result.stdout).toContain(status === 401 ? "authentication required" : "dashboard access denied");
      expect(result.stdout).not.toContain("synthetic-private-response");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("identifies itself before an unavailable-controller diagnostic", async () => {
    const home = mkdtempSync(join(directory, "unavailable-"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await run([], home, { AWX_AXI_ORIGIN: `http://127.0.0.1:${port}`, AWX_AXI_ALLOW_HTTP: "1", AWX_AXI_TOKEN: "synthetic-token" });
    expect(result.code).toBe(0);
    identity(result.stdout);
    expect(result.stdout).toContain("awx: controller unreachable;");
  });

  it.each([
    ["--axi-review-unknown"],
    ["job", "list", "--axi-review-unknown"],
    ["auth", "status", "--axi-review-unknown"],
    ["setup", "hooks", "--axi-review-unknown"],
  ])("rejects unsupported flags before authentication or service calls: %j", async (...args) => {
    const home = mkdtempSync(join(directory, "unknown-"));
    const requests: string[] = [];
    const server = createServer((request, response) => { requests.push(request.url!); response.writeHead(500).end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const result = await run(args, home, { AWX_AXI_ORIGIN: `http://127.0.0.1:${port}`, AWX_AXI_ALLOW_HTTP: "1" });
      expect(result.code).toBe(2);
      expect(result.stdout).toContain("unknown flag --axi-review-unknown");
      expect(result.stdout).not.toMatch(/Move|after the command|AUTH_REQUIRED/);
      expect(result.stdout).toMatch(/Remove the unsupported flag|valid flags/);
      expect(requests).toEqual([]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("keeps every catalog subcommand help usable without authentication", async () => {
    for (const domain of DOMAINS) {
      for (const command of domain.subcommands) {
        const result = await run([domain.name, command.name, "--help"], directory);
        expect(result.code, `${domain.name} ${command.name}`).toBe(0);
        expect(result.stdout).toContain(`awx-axi ${domain.name} ${command.name}`);
        expect(result.stdout).not.toContain("code: AUTH_REQUIRED");
      }
    }
    for (const args of [["auth", "login"], ["auth", "status"], ["auth", "logout"], ["setup", "hooks"], ["config", "path"], ["profile", "list"], ["doctor"], ["update"]]) {
      const result = await run([...args, "--help"], directory);
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stdout).toContain(args[0]);
    }
  }, 60_000);

  it("installs, repeats and repairs all integrations while preserving unrelated settings", async () => {
    const home = mkdtempSync(join(directory, "hooks-"));
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true });
    const openCodeSettings = { theme: "system", plugin: ["unrelated-plugin"] };
    writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify(openCodeSettings));
    writeFileSync(join(home, ".config/opencode/plugins/unrelated.js"), "export const unrelated = true;");
    const unrelated = { type: "command", command: "echo unrelated", timeout: 5 };
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ hooks: [unrelated] }] } }));
    writeFileSync(join(home, ".codex/hooks.json"), JSON.stringify({ custom: 42, hooks: { SessionStart: [{ hooks: [unrelated] }] } }));
    writeFileSync(join(home, ".codex/config.toml"), 'model = "unrelated-model"\n[features]\nhooks = false\nweb_search = true\n');
    const first = await run(["setup", "hooks"], home);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("installed session-start hooks for Claude Code, Codex, and OpenCode");
    const paths = [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".config/opencode/plugins/axi-awx-axi.js"].map((path) => join(home, path));
    const before = paths.map((path) => readFileSync(path, "utf8"));
    expect(await run(["setup", "hooks"], home)).toEqual(first);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
    expect(json(paths[0]!)).toEqual({ theme: "dark", hooks: { SessionStart: [{ hooks: [unrelated] }, { matcher: "", hooks: [{ type: "command", command: bin, timeout: 10 }] }] } });
    expect(json(paths[1]!)).toEqual({ custom: 42, hooks: { SessionStart: [{ hooks: [unrelated] }, { matcher: "", hooks: [{ type: "command", command: bin, timeout: 10 }] }] } });
    expect(readFileSync(paths[2]!, "utf8")).toBe('model = "unrelated-model"\n[features]\nhooks = true\nweb_search = true\n');
    const relocated = join(home, "relocated-awx-axi");
    symlinkSync(bin, relocated);
    expect((await run(["setup", "hooks"], home, {}, relocated)).code).toBe(0);
    expect(hookCommand(paths[0]!)).toBe(relocated);
    expect(hookCommand(paths[1]!)).toBe(relocated);
    expect(json(join(home, ".config/opencode/opencode.json"))).toEqual(openCodeSettings);
    expect(readFileSync(join(home, ".config/opencode/plugins/unrelated.js"), "utf8")).toBe("export const unrelated = true;");
    // Execute the generated plugin through its real OpenCode integration API.
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const { AxiAwxAxiAmbientContextPlugin } = await import(pathToFileURL(process.argv[1]).href);
      const hooks = await AxiAwxAxiAmbientContextPlugin({ directory: process.argv[2] });
      const output = { system: [] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "isolated" }, output);
      console.log(output.system.join("\\n"));
    `, paths[3]!, home], { cwd: home, env: isolatedEnv(home), timeout: 15_000 });
    expect(stdout).toContain("## AXI ambient context: awx-axi");
    expect(stdout).toContain("bin: ~/relocated-awx-axi");
    expect(stdout).toContain("description: Inspect and run AWX automation from the shell");
    expect(stdout).toContain("awx: controller configuration required;");
  });

  it.each(["malformed", "unwritable", "collision", "all-failed"])("reports hook setup failures without exposing settings: %s", async (scenario) => {
    const home = mkdtempSync(join(directory, "hook-failure-"));
    const claude = join(home, ".claude/settings.json");
    const plugin = join(home, ".config/opencode/plugins/axi-awx-axi.js");
    if (scenario === "malformed") {
      mkdirSync(join(home, ".claude"));
      writeFileSync(claude, '{"private":"synthetic-secret", broken');
    } else if (scenario === "unwritable") {
      mkdirSync(join(home, ".claude"));
      writeFileSync(claude, "{}");
      chmodSync(claude, 0o400);
    }
    else if (scenario === "collision") {
      mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true });
      writeFileSync(plugin, "export const custom = true;");
    } else {
      writeFileSync(join(home, ".claude"), "blocked");
      writeFileSync(join(home, ".codex"), "blocked");
      writeFileSync(join(home, ".config"), "blocked");
    }
    const result = await run(["setup", "hooks"], home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("code: HOOK_INSTALL_FAILED");
    expect(result.stdout).toContain(scenario === "all-failed" ? "hooks: failed" : "hooks: partial failure");
    expect(result.stdout).toContain(scenario === "collision" ? plugin : claude);
    expect(result.stdout).not.toMatch(/synthetic-secret|installed session-start hooks for/);
    if (scenario === "collision") expect(readFileSync(plugin, "utf8")).toBe("export const custom = true;");
    else if (scenario === "malformed") expect(readFileSync(claude, "utf8")).toBe('{"private":"synthetic-secret", broken');
    if (scenario !== "all-failed") expect(hookCommand(join(home, ".codex/hooks.json"))).toBe(bin);
  });
});
