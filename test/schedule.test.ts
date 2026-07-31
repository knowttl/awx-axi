import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("schedule list (design.md §7.10?)", () => {
  it("lists schedules with template and enabled filters across pages", async () => {
    const run = await runCli([
      "schedule",
      "list",
      "--template",
      "77",
      "--enabled",
      "--limit",
      "3",
    ], {
      script: ["schedule-list-page-1", "schedule-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "schedules/",
      query: {
        unified_job_template: 77,
        enabled: true,
        page_size: 3,
      },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "/api/v2/schedules/",
    });
    expect(run.stdout).toContain("schedules[3]{id,name,template,enabled,next_run}:");
    expect(run.stdout).toContain("201,nightly-security-scan,77 (Security scan template),enabled");
    expect(run.stdout).toContain("Run `awx-axi schedule show <id|name>` to inspect schedule detail and timing");
  });

  it("supports search and disabled filters", async () => {
    const run = await runCli([
      "schedule",
      "list",
      "--search",
      "compliance",
      "--disabled",
    ], {
      script: ["schedule-list-page-1", "schedule-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toMatchObject({
      search: "compliance",
      enabled: false,
    });
  });

  it("shows schedule detail with preview and template resolution", async () => {
    const run = await runCli(["schedule", "show", "Nightly security scan"], {
      script: ["schedule-name-one", "schedule-show"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "schedules/",
      query: { name: "Nightly security scan" },
    });
    expect(run.transport.requests[1]).toMatchObject({
      route: "schedules/201/",
    });
    expect(run.stdout).toContain("id: 201");
    expect(run.stdout).toContain("template: 77 (Security scan template)");
    expect(run.stdout).toContain('preview: "zone UTC:');
    expect(run.stdout).toContain("awx-axi schedule list --template 77");
  });

  it("rejects a non-positive --limit", async () => {
    const run = await runCli(["schedule", "list", "--limit", "0"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
  });

  it("schedule create and edit support dry-run and --confirm", async () => {
    const dryCreate = await runCli(["schedule", "create", "Nightly Backup", "--template", "12"], { script: [] });
    expect(dryCreate.exitCode).toBe(0);
    expect(dryCreate.stdout).toContain("dry_run:");
    expect(dryCreate.stdout).toContain("would_send: POST schedules/");

    const liveCreate = await runCli(["schedule", "create", "Nightly Backup", "--template", "12", "--confirm"], {
      script: [{ status: 201, body: { id: 30, name: "Nightly Backup", enabled: true } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveCreate.exitCode).toBe(0);
    expect(liveCreate.stdout).toContain("id: 30");

    const dryEdit = await runCli(["schedule", "edit", "30", "--disabled"], { script: [] });
    expect(dryEdit.exitCode).toBe(0);
    expect(dryEdit.stdout).toContain("would_send: PATCH schedules/30/");

    const liveEdit = await runCli(["schedule", "edit", "30", "--disabled", "--confirm"], {
      script: [{ status: 200, body: { id: 30, name: "Nightly Backup", enabled: false } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveEdit.exitCode).toBe(0);
    expect(liveEdit.stdout).toContain("id: 30");
  });
});
