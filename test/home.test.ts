import { AxiError } from "axi-sdk-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { registerSecret } from "../src/core/redact.js";
import { RecordedTransport } from "../src/core/transport.js";
import { exchange } from "./support/fixtures.js";
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
