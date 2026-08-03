import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("template domain (design.md §7.4, §7.5)", () => {
  it("template list lists job templates", async () => {
    const run = await runCli(["template", "list"], {
      script: ["job-templates-name-one"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("count: 1 total");
    expect(run.stdout).toContain("job_templates[1]{id,name,project,last_job_run}:");
    expect(run.stdout).toContain("12,Deploy web tier");
  });

  it("template show displays prompts on launch and survey status", async () => {
    const run = await runCli(["template", "show", "12"], {
      script: ["template-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 12");
    expect(run.stdout).toContain("name: Deploy web tier");
    expect(run.stdout).toContain("prompts_on_launch");
  });

  it("template survey displays survey questions", async () => {
    const run = await runCli(["template", "survey", "12"], {
      script: ["template-survey"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("survey:");
    expect(run.stdout).toContain("Target Environment");
  });

  it("template launch refuses unprompted flags at launch preflight (§7.5)", async () => {
    const run = await runCli(["template", "launch", "18", "--limit", "db-02"], {
      script: ["launch-preflight-no-limit"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: LAUNCH_WOULD_IGNORE_INPUT");
    expect(run.stdout).toContain("template 18 does not accept --limit at launch");
    expect(run.transport.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("template launch dry run issues no POST", async () => {
    const run = await runCli(["template", "launch", "12", "--limit", "web-01", "--dry-run"], {
      script: ["launch-preflight-accepts-limit"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("would_send: POST job_templates/12/launch/");
    expect(run.transport.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("template launch executes POST when preflight passes", async () => {
    const run = await runCli(["template", "launch", "12", "--limit", "web-01", "--confirm"], {
      script: [
        "launch-preflight-accepts-limit",
        { status: 201, body: { id: 1844, status: "pending" } },
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 1844");
    expect(run.transport.requests[1]).toMatchObject({
      method: "POST",
      route: "job_templates/12/launch/",
      body: { limit: "web-01" },
    });
  });

  it("template launch reports ignored fields warning if controller drops fields (§7.5)", async () => {
    const run = await runCli(["template", "launch", "12", "--confirm"], {
      script: [
        "launch-preflight-accepts-limit",
        "launch-201-ignored-fields",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("warning:");
    expect(run.stdout).toContain("fields were ignored by the controller");
  });

  it("template create, edit, copy support dry-run and --confirm", async () => {
    const dryCreate = await runCli(["template", "create", "New Template"], { script: [] });
    expect(dryCreate.exitCode).toBe(0);
    expect(dryCreate.stdout).toContain("dry_run:");
    expect(dryCreate.stdout).toContain("would_send: POST job_templates/");

    const liveCreate = await runCli(["template", "create", "New Template", "--confirm"], {
      script: [{ status: 201, body: { id: 25, name: "New Template" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveCreate.exitCode).toBe(0);
    expect(liveCreate.stdout).toContain("id: 25");

    const dryEdit = await runCli(["template", "edit", "25", "--description", "Updated desc"], { script: [] });
    expect(dryEdit.exitCode).toBe(0);
    expect(dryEdit.stdout).toContain("would_send: PATCH job_templates/25/");

    const dryCopy = await runCli(["template", "copy", "25", "--name", "Copied Template"], { script: [] });
    expect(dryCopy.exitCode).toBe(0);
    expect(dryCopy.stdout).toContain("would_send: POST job_templates/25/copy/");

    const liveCopy = await runCli(["template", "copy", "25", "--name", "Copied Template", "--confirm"], {
      script: [{ status: 201, body: { id: 26, name: "Copied Template" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveCopy.exitCode).toBe(0);
    expect(liveCopy.stdout).toContain("id: 26");
  });

  it("template delete supports dry-run and --confirm", async () => {
    const dryDelete = await runCli(["template", "delete", "12"], { script: [] });
    expect(dryDelete.exitCode).toBe(0);
    expect(dryDelete.stdout).toContain("dry_run:");
    expect(dryDelete.stdout).toContain("would_send: DELETE job_templates/12/");

    const liveDelete = await runCli(["template", "delete", "12", "--confirm"], {
      script: [{ status: 204 }],
      env: { AWX_AXI_ALLOW_DELETES: "1" },
    });
    expect(liveDelete.exitCode).toBe(0);
    expect(liveDelete.stdout).toContain("status: deleted");
    expect(liveDelete.transport.requests[0]).toMatchObject({
      method: "DELETE",
      route: "job_templates/12/",
    });
  });
});
