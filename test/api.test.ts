import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

const WRITES_ON = { AWX_AXI_ALLOW_SECURITY_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_CONFIG_WRITES: "1" };

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
    ["post", "POST"],
    ["put", "PUT"],
    ["patch", "PATCH"],
    ["delete", "DELETE"],
  ])("%s --confirm sends %s when gates are enabled", async (verb, method) => {
    const run = await runCli(["api", verb, "labels/7/", "--confirm"], {
      env: WRITES_ON,
      script: [{ status: 204 }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toMatchObject([{ method, route: "labels/7/" }]);
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
    [{ AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, "SECURITY_WRITES_DISABLED"],
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

  it.each([
    ["post", "bulk/host_delete/", "DELETE_WRITES_DISABLED"],
    ["post", "labels/", "CONFIG_WRITES_DISABLED"],
    ["patch", "labels/7/", "CONFIG_WRITES_DISABLED"],
    ["post", "credentials/", "SECURITY_WRITES_DISABLED"],
  ])("gates %s %s", async (verb, path, code) => {
    const run = await runCli(["api", verb, path, "--confirm"], { env: {} });
    expect(run.stdout).toContain(code);
    expect(run.transport.requests).toEqual([]);
  });

  it("requires a private file and password gate for launch passwords", async () => {
    const run = await runCli(["api", "post", "job_templates/1/launch/", "--body", '{"credential_passwords":{"ssh_password":"sensitive-value"}}', "--confirm"], { env: WRITES_ON });
    expect(run.stdout).toContain("LAUNCH_INPUT_REQUIRED");
    expect(run.transport.requests).toEqual([]);
  });

  it("masks custom credential inputs in previews and controller responses", async () => {
    const args = ["api", "post", "credentials/", "--body", '{"inputs":{"custom_field":"sensitive-value"}}'];
    const preview = await runCli(args);
    const live = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: "sensitive-value" } }] });
    expect(preview.stdout).not.toContain("sensitive-value");
    expect(live.stdout).not.toContain("sensitive-value");
  });

  it.each(["post", "put", "patch"])("%s gates named resources that resemble actions", async (verb) => {
    const run = await runCli(["api", verb, "job_templates/launch/", "--confirm"], { env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" } });
    expect(run.stdout).toContain("CONFIG_WRITES_DISABLED");
    expect(run.transport.requests).toEqual([]);
  });

  it("gates a named resource that resembles a security collection", async () => {
    const run = await runCli(["api", "patch", "job_templates/credentials/", "--confirm"], { env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" } });
    expect(run.stdout).toContain("CONFIG_WRITES_DISABLED");
    expect(run.transport.requests).toEqual([]);
  });

  it.each(["post", "put", "patch", "delete"])("%s refuses writes without the security gate", async (verb) => {
    const run = await runCli(["api", verb, "labels/7/", "--confirm"], { env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1" } });
    expect(run.stdout).toContain("SECURITY_WRITES_DISABLED");
    expect(run.transport.requests).toEqual([]);
  });

  it("allows an operational action on a named resource", async () => {
    const run = await runCli(["api", "post", "job_templates/example/launch/", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" }, script: [{ status: 202 }],
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("status: 202");
  });

  it.each([
    ['{"inputs":{"custom_field":"abc123"}}', "abc123"],
    ['{"credential_passwords":{"ssh":"xyz456"}}', "xyz456"],
    ['{"notification_configuration":{"headers":{"Authorization":"short"}}}', "short"],
    ['{"headers":{"Proxy-Authorization":"brief"}}', "brief"],
  ])("masks sensitive body values in previews and responses: %s", async (body, secret) => {
    const args = ["api", "post", "credentials/", "--body", body];
    const preview = await runCli(args);
    const success = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 201, body: { echoed: `value ${secret}` } }] });
    const failure = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: `value ${secret}` } }] });
    expect(preview.stdout).not.toContain(secret);
    expect(success.stdout).not.toContain(secret);
    expect(failure.stdout).not.toContain(secret);
    expect(success.exitCode).toBe(0);
    expect(failure.exitCode).toBe(2);
  });

  it("masks a private notification body in previews and errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awx-axi-api-"));
    try {
      const file = join(dir, "body.json");
      writeFileSync(file, '{"notification_configuration":{"headers":{"Authorization":"abc123"}}}', { mode: 0o600 });
      const args = ["api", "post", "notification_templates/", "--body-file", file];
      const preview = await runCli(args);
      const failure = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: "rejected abc123" } }] });
      expect(preview.stdout).not.toContain("abc123");
      expect(failure.stdout).not.toContain("abc123");
      expect(failure.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves repeated query values and reads text", async () => {
    const run = await runCli(["api", "get", "jobs/1/stdout/", "--query", "format=txt&chain__name=a&chain__name=b"], { script: [{ status: 200, body: "hello world" }] });
    expect(run.transport.requests[0]?.query).toEqual({ format: "txt", chain__name: ["a", "b"] });
    expect(run.stdout).toContain("hello world");
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
