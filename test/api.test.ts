import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

const WRITES_ON = { AWX_AXI_ALLOW_SECURITY_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_CONFIG_WRITES: "1" };

async function withBody(body: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "awx-axi-api-"));
  try {
    const file = join(dir, "body.json");
    writeFileSync(file, body, { mode: 0o600 });
    await run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("api domain", () => {
  it("get reads the API root using a dot path", async () => {
    const run = await runCli(["api", "get", ".", "--query", "format=json"], {
      script: [{ status: 200, body: { jobs: "/api/v2/jobs/" } }],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toEqual([{ method: "GET", route: ".", query: { format: "json" } }]);
    expect(run.stdout).toContain("/api/v2/jobs/");
  });

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
    ["./jobs/"],
    ["jobs/%2e%2e/admin/"],
    ["jobs/?page=2"],
    ["https://evil.example/"],
  ])("rejects the unsafe path %s before any request", async (path) => {
    const run = await runCli(["api", "get", path]);

    expect(run.exitCode).toBe(2);
    expect(run.transport.requests).toEqual([]);
  });

  it.each(["post", "put", "patch", "delete"])("%s rejects a dot path", async (verb) => {
    const run = await runCli(["api", verb, ".", "--confirm"], { env: WRITES_ON });
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
    await withBody('{"name":"x","inputs":{"password":"hunter2hunter2"}}', async (file) => {
      const run = await runCli(["api", "post", "credentials/", "--body-file", file], { env: WRITES_ON });
      expect(run.stdout).toContain("name: x");
      expect(run.stdout).not.toContain("hunter2hunter2");
    });
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
    await withBody('{"name":"prod","organization":1}', async (file) => {
      const run = await runCli(["api", "post", "labels/", "--body-file", file, "--confirm"], {
        env: WRITES_ON,
        script: [{ status: 201, body: { id: 9, name: "prod" } }],
      });
      expect(run.transport.requests[0]?.body).toEqual({ name: "prod", organization: 1 });
      expect(run.stdout).toContain("status: 201");
    });
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

  it.each(["post", "put", "patch"])("%s rejects inline bodies", async (verb) => {
    const run = await runCli(["api", verb, "labels/", "--body", "{}", "--confirm"], { env: WRITES_ON });
    expect(run.exitCode).toBe(2);
    expect(run.transport.requests).toEqual([]);
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
    await withBody('{"credential_passwords":{"ssh_password":"sensitive-value"}}', async (file) => {
      const run = await runCli(["api", "post", "job_templates/1/launch/", "--body-file", file, "--confirm"], { env: WRITES_ON });
      expect(run.stdout).toContain("LAUNCH_INPUT_REQUIRED");
      expect(run.transport.requests).toEqual([]);
    });
  });

  it("masks custom credential inputs in previews and controller responses", async () => {
    await withBody('{"inputs":{"custom_field":"sensitive-value"}}', async (file) => {
      const args = ["api", "post", "credentials/", "--body-file", file];
      const preview = await runCli(args);
      const live = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: "sensitive-value" } }] });
      expect(preview.stdout).not.toContain("sensitive-value");
      expect(live.stdout).not.toContain("sensitive-value");
    });
  });

  it.each([
    ["bulk/job_launch/", []],
    ["bulk/job_launch/", ["--confirm"]],
    ["Bulk/Job_Launch", ["--confirm"]],
  ])("refuses %s with %j because bulk job launch is excluded", async (path, extra) => {
    const run = await runCli(["api", "post", path, ...extra], { env: WRITES_ON });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("bulk job launch is excluded");
    expect(run.transport.requests).toEqual([]);
  });

  it.each([
    ["JSON", '{"extra_vars":"{\\"password\\":\\"hunter2\\"}"}'],
    ["YAML", '{"extra_vars":"password: hunter2\\nenv: prod"}'],
  ])("masks serialized %s extra_vars secrets in previews and controller responses", async (_format, body) => {
    await withBody(body, async (file) => {
      const args = ["api", "post", "job_templates/7/launch/", "--body-file", file];
      const preview = await runCli(args);
      const live = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: "hunter2" } }] });
      expect(preview.stdout).not.toContain("hunter2");
      expect(live.stdout).not.toContain("hunter2");
    });
  });

  it("keeps non-secret serialized extra_vars visible in previews", async () => {
    await withBody('{"extra_vars":"{\\"env\\":\\"prod\\"}"}', async (file) => {
      const run = await runCli(["api", "post", "job_templates/7/launch/", "--body-file", file]);
      expect(run.stdout).toContain("prod");
    });
  });

  it.each(["post", "put", "patch"])("masks malformed serialized extra_vars in %s previews and responses", async (verb) => {
    const extraVars = "password: hunter2\ninvalid: [";
    await withBody(JSON.stringify({ extra_vars: extraVars }), async (file) => {
      const args = ["api", verb, "job_templates/7/", "--body-file", file];
      const preview = await runCli(args);
      const success = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 200, body: { echoed: extraVars } }] });
      const failure = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: `Invalid variables: ${extraVars}` } }] });
      expect(preview.exitCode).toBe(0);
      expect(success.exitCode).toBe(0);
      expect(failure.exitCode).toBe(2);
      expect(preview.stdout).not.toContain("hunter2");
      expect(success.stdout).not.toContain("hunter2");
      expect(failure.stdout).not.toContain("hunter2");
    });
  });

  it("masks credential inputs with unrecognized field names in GET collections and write responses", async () => {
    const credential = { id: 1, credential_type: 1, inputs: { ssh_key_data: "ssh-key-material", username: "svc-account" } };
    const read = await runCli(["api", "get", "workflow_job_template_nodes/1/credentials/"], {
      script: [{ status: 200, body: { count: 1, results: [credential] } }],
    });
    const write = await runCli(["api", "post", "credentials/", "--confirm"], { env: WRITES_ON, script: [{ status: 201, body: credential }] });
    for (const run of [read, write]) {
      expect(run.stdout).not.toContain("ssh-key-material");
      expect(run.stdout).not.toContain("svc-account");
    }
  });

  it("keeps inputs visible on resources that are not credentials", async () => {
    const run = await runCli(["api", "get", "credential_types/1/"], {
      script: [{ status: 200, body: { id: 1, kind: "cloud", inputs: { fields: [{ id: "host" }] } } }],
    });
    expect(run.stdout).toContain("host");
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
    ['{"password":"abc123"}', "abc123"],
    ['{"nested":{"access_token":"tiny"}}', "tiny"],
    ['{"api_key":"key123"}', "key123"],
  ])("masks sensitive body values in previews and responses: %s", async (body, secret) => {
    await withBody(body, async (file) => {
      const args = ["api", "post", "credentials/", "--body-file", file];
      const preview = await runCli(args);
      const success = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 201, body: { echoed: secret } }] });
      const failure = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: secret } }] });
      expect(preview.stdout).not.toContain(secret);
      expect(success.stdout).not.toContain(secret);
      expect(failure.stdout).not.toContain(secret);
      expect(success.exitCode).toBe(0);
      expect(failure.exitCode).toBe(2);
    });
  });

  it("masks a private notification body in previews and errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awx-axi-api-"));
    try {
      const file = join(dir, "body.json");
      writeFileSync(file, '{"notification_configuration":{"headers":{"Authorization":"abc123"}}}', { mode: 0o600 });
      const args = ["api", "post", "notification_templates/", "--body-file", file];
      const preview = await runCli(args);
      const failure = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: "abc123" } }] });
      expect(preview.stdout).not.toContain("abc123");
      expect(failure.stdout).not.toContain("abc123");
      expect(failure.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { headers: { Authorization: "stored-header" } },
    { results: [{ headers: { "Proxy-Authorization": "stored-header" } }] },
  ])("redacts stored authorization headers from GET responses", async (body) => {
    const run = await runCli(["api", "get", "notification_templates/"], { script: [{ status: 200, body }] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("stored-header");
    expect(run.stdout).toContain("***");
  });

  it("redacts stored authorization headers from write responses", async () => {
    const run = await runCli(["api", "post", "credentials/", "--confirm"], { env: WRITES_ON, script: [{ status: 201, body: { headers: { Authorization: "stored-header" } } }] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("stored-header");
    expect(run.stdout).toContain("***");
  });

  it("preserves error details and response keys containing short secrets", async () => {
    await withBody('{"password":"e"}', async (file) => {
      const args = ["api", "post", "credentials/", "--body-file", file, "--confirm"];
      const failure = await runCli(args, { env: WRITES_ON, script: [{ status: 403, body: { detail: "Account disabled" } }] });
      const success = await runCli(args, { env: WRITES_ON, script: [{ status: 201, body: { detail: "enabled", exact: "e" } }] });
      expect(failure.stdout).toContain("Account disabled");
      expect(success.stdout).toContain("detail: enabled");
      expect(success.stdout).toContain("exact: ***");
    });
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
