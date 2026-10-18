import { AxiError } from "axi-sdk-js";
import { decode } from "@toon-format/toon";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { registerSecret } from "../src/core/redact.js";
import { RecordedTransport } from "../src/core/transport.js";
import * as tlsFetch from "../src/core/tls-fetch.js";
import { exchange, fixtureFetch } from "./support/fixtures.js";
import { runCli } from "./support/run.js";

let env: { HOME: string; AWX_AXI_HOME: string; XDG_CONFIG_HOME: string; AWX_AXI_ORIGIN: string; AWX_AXI_TOKEN: string };
const previousExitCode = process.exitCode;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "awx-home-test-"));
  env = {
    HOME: home, AWX_AXI_HOME: join(home, "legacy"), XDG_CONFIG_HOME: join(home, ".config"),
    AWX_AXI_ORIGIN: "https://awx.example.com", AWX_AXI_TOKEN: "synthetic-test-token",
  };
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  rmSync(env.HOME, { recursive: true, force: true });
});

describe("session dashboard", () => {
  it("keeps a selected profile when following the home history suggestion", async () => {
    const config = join(env.HOME, "controllers.json");
    writeFileSync(config, JSON.stringify({ version: 1, defaultProfile: "dev", profiles: {
      dev: { origin: "https://dev.example.com", token: { env: "AWX_AXI_TOKEN" } },
      prod: { origin: "https://prod.example.com", token: { env: "AWX_AXI_TOKEN" } },
    } }));
    const fixtures = fixtureFetch(["home-empty", "home-empty", "home-empty", "home-dashboard"]);
    vi.spyOn(tlsFetch, "createTlsFetch").mockReturnValue(fixtures.fetch);
    let text = "";
    const stdout = { write: (chunk: string) => { text += chunk; } };
    await main({ argv: ["--config", config, "--profile", "prod"], env, stdout });
    expect(text).toContain("controller: prod.example.com");
    const home = decode(text) as { help: string[] };
    const command = home.help[0]!.slice(5, home.help[0]!.lastIndexOf("`"));
    const args = execFileSync("bash", ["-c", `awx-axi() { printf '%s\\0' "$@"; }; ${command}`])
      .toString().split("\0").slice(0, -1);
    expect(args).toEqual(["--config", config, "--profile", "prod", "job", "list"]);
    text = "";
    await main({ argv: args, env, stdout });
    expect(text).toContain("Deploy web");
    expect(fixtures.calls.map((call) => call.url.host)).toEqual(Array(4).fill("prod.example.com"));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each(["controllers 'quoted' $(printf unsafe) `printf unsafe`.json", "controllers\n\r\t'\\.json"])(
    "preserves shell arguments across all home suggestions with config %j", async (filename) => {
      const config = join(env.HOME, filename);
      writeFileSync(config, JSON.stringify({ version: 1, profiles: {
        prod: { origin: "https://prod.example.com", token: { env: "AWX_AXI_TOKEN" } },
      } }));
      const selectors = ["--config", config, "--profile", "prod", "--origin", "https://override.example.com", "--verify-ssl", "false"];
      const result = await runCli(selectors, { env, script: ["home-dashboard", "home-dashboard", "home-dashboard"] });
      const home = decode(result.stdout) as { help: string[] };
      const commands = home.help.map((hint) => hint.slice(5, hint.lastIndexOf("`")).replace("<id>", "101"));
      const args = commands.map((command) => execFileSync("bash", ["-c", `awx-axi() { printf '%s\\0' "$@"; }; ${command}`])
        .toString().split("\0").slice(0, -1));
      expect(args).toEqual([
        [...selectors, "job", "show", "101"],
        [...selectors, "approval", "show", "101"],
        [...selectors, "template", "list"],
        [...selectors, "job", "list"],
        [...selectors, "approval", "list"],
        [...selectors, "job", "list", "--failed", "--since", "24h"],
      ]);
      expect(commands.every((command) => !/[\n\r]/.test(command))).toBe(true);
      expect(result.exitCode).toBe(0);
    },
  );

  it.each([[401, "login"], [403, "status"]] as const)(
    "preserves shell arguments in the single-line diagnostic for HTTP %s", async (status, action) => {
      const config = join(env.HOME, "missing\n'$(printf unsafe)`printf unsafe`\\.json");
      const selectors = ["--config", config, "--profile", "prod", "--origin", "https://override.example.com", "--verify-ssl", "false"];
      const result = await runCli(selectors, { env, script: [] });
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      const recovery = result.stdout.slice(result.stdout.indexOf("Run `") + 5, result.stdout.lastIndexOf("`"));
      const args = execFileSync("bash", ["-c", `awx-axi() { printf '%s\\0' "$@"; }; ${recovery}`])
        .toString().split("\0").slice(0, -1);
      expect(args).toEqual([...selectors, "auth", "status"]);
      writeFileSync(config, JSON.stringify({ version: 1, profiles: {
        prod: { origin: "https://prod.example.com", token: { env: "AWX_AXI_TOKEN" } },
      } }));
      const failed = await runCli(selectors, { env, script: [
        exchange("home-empty"), { status, body: { detail: "unsafe\nresponse" } }, exchange("home-empty"),
      ] });
      expect(failed.stdout.trim().split("\n")).toHaveLength(1);
      const command = failed.stdout.slice(failed.stdout.indexOf("Run `") + 5, failed.stdout.lastIndexOf("`"));
      const failedArgs = execFileSync("bash", ["-c", `awx-axi() { printf '%s\\0' "$@"; }; ${command}`])
        .toString().split("\0").slice(0, -1);
      expect(failedArgs).toEqual([...selectors, "auth", action]);
      expect(failed.stdout).not.toContain("unsafe\nresponse");
      expect(failed.exitCode).toBe(0);
    },
  );

  it("shows bounded live blocks from exactly three filtered reads without following next", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-27T14:20:11Z"));
    const result = await runCli([], { env, script: [
      exchange("home-dashboard"), exchange("approval-list-pending"),
      { status: 200, body: { count: 1, results: [{ id: 99, name: "Deploy db", status: "failed", finished: "2026-07-27T13:41:02Z" }] } },
    ] });
    expect(result.stdout).toContain("controller: awx.example.com");
    expect(result.stdout).toContain("running[5]{id,name,status,elapsed}:");
    expect(result.stdout).toContain("101,Deploy web,running,142");
    expect(result.stdout).not.toContain("Beyond cap");
    expect(result.stdout).toContain("57,Release pipeline,18m");
    expect(result.stdout).toContain("99,Deploy db,failed");
    expect(result.stdout).toContain("5 of 8 shown");
    expect(result.transport.requests).toEqual([
      { method: "GET", route: "jobs/", query: { status__in: "new,pending,waiting,running", order_by: "-id", page_size: 5 } },
      { method: "GET", route: "workflow_approvals/", query: { status: "pending", order_by: "created", page_size: 5 } },
      { method: "GET", route: "jobs/", query: { status__in: "failed,error", finished__gte: "2026-07-26T14:20:11.000Z", order_by: "-finished", page_size: 3 } },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("states all three zeros on a quiet controller", async () => {
    const result = await runCli([], { env, script: ["home-empty", "home-empty", "home-empty"] });
    expect(result.stdout).toContain("running: 0 jobs running");
    expect(result.stdout).toContain("approvals: 0 approvals pending");
    expect(result.stdout).toContain("failures: 0 failures in the last 24h");
    expect(result.exitCode).toBe(0);
  });

  it.each([401, 403, 500])("keeps partial request failure %s to one safe line and exits zero", async (status) => {
    const result = await runCli([], { env, script: [
      exchange("home-empty"), { status, body: { detail: "sensitive response\nsecond line" } }, exchange("home-empty"),
    ] });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("awx:");
    expect(result.stdout).toContain("Run `awx-axi auth");
    expect(result.stdout).not.toMatch(/sensitive|second line|0 jobs/);
    expect(result.transport.requests).toHaveLength(3);
    expect(result.exitCode).toBe(0);
  });

  it("handles missing configuration without network access", async () => {
    let text = "";
    const createTransport = vi.fn();
    await main({ argv: [], env: { HOME: env.HOME, AWX_AXI_HOME: env.AWX_AXI_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }, createTransport, stdout: { write: (chunk) => { text += chunk; } } });
    expect(text).toBe("awx: controller configuration required; Run `awx-axi auth status` to check configuration and access\n");
    expect(createTransport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("does not expose arbitrary exception messages in hook output", async () => {
    let text = "";
    await main({ argv: [], env, createTransport: () => { throw new Error("token=secret\nstack trace"); }, stdout: { write: (chunk) => { text += chunk; } } });
    expect(text).toBe("awx: dashboard unavailable; Run `awx-axi auth status` to check configuration and access\n");
    expect(process.exitCode).toBe(0);
  });

  it("does not mistake a malformed list response for a zero state", async () => {
    const result = await runCli([], { env, script: [
      "home-empty", { status: 200, body: { count: 4, results: [] } }, "home-empty",
    ] });
    expect(result.stdout).toBe("awx: dashboard unavailable; Run `awx-axi auth status` to check configuration and access\n");
    expect(result.exitCode).toBe(0);
  });

  it("keeps unreachable controller failures safe and exits zero", async () => {
    let text = "";
    await main({ argv: [], env, createTransport: () => { throw new AxiError("unsafe network details", "CONTROLLER_UNREACHABLE"); }, stdout: { write: (chunk) => { text += chunk; } } });
    expect(text).toBe("awx: controller unreachable; Run `awx-axi auth status` to check configuration and access\n");
    expect(process.exitCode).toBe(0);
  });

  it("redacts registered credentials and URL userinfo from dashboard rows", async () => {
    const transport = new RecordedTransport([
      { status: 200, body: { count: 1, results: [{ id: 1, name: "synthetic-test-token https://user:pass@example.com", status: "running", elapsed: 1 }] } },
      exchange("home-empty"), exchange("home-empty"),
    ]);
    let text = "";
    await main({ argv: [], env, createTransport: () => { registerSecret(env.AWX_AXI_TOKEN); return transport; }, stdout: { write: (chunk) => { text += chunk; } } });
    expect(text).toContain("*** https://***@example.com");
    expect(text).not.toMatch(/synthetic-test-token|user:pass/);
  });

  it("preserves explicit command authentication errors and nonzero exits", async () => {
    let text = "";
    await main({ argv: ["job", "list"], env, createTransport: () => { throw new AxiError("credential expired", "AUTH_REQUIRED"); }, stdout: { write: (chunk) => { text += chunk; } } });
    expect(text).toContain("error: credential expired");
    expect(text).toContain("code: AUTH_REQUIRED");
    expect(process.exitCode).toBe(1);
  });
});
