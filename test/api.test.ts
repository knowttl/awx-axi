import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

const WRITES_ON = { AWX_AXI_ALLOW_SECURITY_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1" };

describe("api domain", () => {
  it("get reads a base-relative path with its query and redacts sensitive keys", async () => {
    const run = await runCli(["api", "get", "jobs/1839/", "--query", "page_size=5&status=failed"], {
      script: [{ status: 200, body: { id: 1839, token: "abcdefghijkl", name: "deploy" } }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toEqual([
      { method: "GET", route: "jobs/1839/", query: { page_size: "5", status: "failed" } },
    ]);
    expect(run.stdout).toContain("status: 200");
    expect(run.stdout).toContain("name: deploy");
    expect(run.stdout).not.toContain("abcdefghijkl");
  });

  it("get maps a non-2xx response to its error code", async () => {
    const run = await runCli(["api", "get", "jobs/999999/"], { script: [{ status: 404, body: { detail: "Not found." } }] });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("NOT_FOUND");
  });

  it.each([
    ["/api/v2/jobs/"],
    ["../admin/"],
    ["jobs/../../admin/"],
    ["jobs/%2e%2e/admin/"],
    ["jobs/?page=2"],
    ["https://evil.example/"],
  ])("rejects the unsafe path %s before any request", async (path) => {
    const run = await runCli(["api", "get", path]);

    expect(run.exitCode).toBe(2);
    expect(run.transport.requests).toEqual([]);
  });

  it.each(["post", "put", "patch", "delete"])("%s previews without --confirm and sends nothing", async (verb) => {
    const run = await runCli(["api", verb, "labels/7/"], { env: WRITES_ON });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toEqual([]);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain(`would_send: ${verb.toUpperCase()} labels/7/`);
    expect(run.stdout).toContain("--confirm");
  });

  it("preview redacts secrets in the body", async () => {
    const run = await runCli(["api", "post", "credentials/", "--body", '{"name":"x","inputs":{"password":"hunter2hunter2"}}'], {
      env: WRITES_ON,
    });

    expect(run.stdout).toContain("name: x");
    expect(run.stdout).not.toContain("hunter2hunter2");
  });

  it.each([
    ["post", "POST", "security"],
    ["put", "PUT", "security"],
    ["patch", "PATCH", "security"],
    ["delete", "DELETE", "security"],
  ])("%s --confirm sends %s with the %s tag", async (verb, method, tag) => {
    const run = await runCli(["api", verb, "labels/7/", "--confirm"], {
      env: WRITES_ON,
      script: [{ status: 204 }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toEqual([{ method, route: "labels/7/", query: {}, tag }]);
    expect(run.stdout).toContain("status: 204");
  });

  it("--dry-run overrides --confirm", async () => {
    const run = await runCli(["api", "post", "jobs/1/cancel/", "--confirm", "--dry-run"], { env: WRITES_ON });

    expect(run.transport.requests).toEqual([]);
    expect(run.stdout).toContain("dry_run:");
  });

  it("post sends the parsed body", async () => {
    const run = await runCli(["api", "post", "labels/", "--body", '{"name":"prod","organization":1}', "--confirm"], {
      env: WRITES_ON,
      script: [{ status: 201, body: { id: 9, name: "prod" } }],
    });

    expect(run.transport.requests[0]?.body).toEqual({ name: "prod", organization: 1 });
    expect(run.stdout).toContain("status: 201");
  });

  it("post reads the body from a private file and rejects a group-readable one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awx-axi-api-"));
    try {
      const file = join(dir, "body.json");
      writeFileSync(file, '{"name":"from-file"}');
      chmodSync(file, 0o600);
      const ok = await runCli(["api", "post", "labels/", "--body-file", file, "--confirm"], {
        env: WRITES_ON,
        script: [{ status: 201, body: {} }],
      });
      expect(ok.transport.requests[0]?.body).toEqual({ name: "from-file" });

      chmodSync(file, 0o644);
      const insecure = await runCli(["api", "post", "labels/", "--body-file", file, "--confirm"], { env: WRITES_ON });
      expect(insecure.exitCode).toBe(1);
      expect(insecure.stdout).toContain("CONFIG_INSECURE");
      expect(insecure.transport.requests).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects --body together with --body-file", async () => {
    const run = await runCli(["api", "post", "labels/", "--body", "{}", "--body-file", "/x", "--confirm"], { env: WRITES_ON });

    expect(run.exitCode).toBe(2);
  });

  it("delete takes no body", async () => {
    const run = await runCli(["api", "delete", "labels/7/", "--body", "{}"]);

    expect(run.exitCode).toBe(2);
  });

  it.each([
    [{}, "SECURITY_WRITES_DISABLED"],
    [{ AWX_AXI_ALLOW_SECURITY_WRITES: "1", AWX_AXI_READ_ONLY: "1" }, "READ_ONLY_VIOLATION"],
  ])("refuses a confirmed write under env %j with %s", async (env, code) => {
    const run = await runCli(["api", "post", "labels/", "--confirm"], { env });

    expect(run.stdout).toContain(code);
    expect(run.transport.requests).toEqual([]);
  });

  it("delete additionally needs the delete gate", async () => {
    const run = await runCli(["api", "delete", "labels/7/", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
    });

    expect(run.stdout).toContain("DELETE_WRITES_DISABLED");
    expect(run.transport.requests).toEqual([]);
  });

  it("write maps a non-2xx response to its error code", async () => {
    const run = await runCli(["api", "post", "labels/", "--confirm"], {
      env: WRITES_ON,
      script: [{ status: 403, body: { detail: "You do not have permission." } }],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("FORBIDDEN");
  });
});
