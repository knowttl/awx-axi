import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("workflow domain (design.md §7.6)", () => {
  it("workflow list lists workflow job templates", async () => {
    const run = await runCli(["workflow", "list"], {
      script: ["workflow-list"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("count: 1 total");
    expect(run.stdout).toContain("workflow_job_templates");
    expect(run.stdout).toContain("Release pipeline");
  });

  it("workflow show displays detail", async () => {
    const run = await runCli(["workflow", "show", "10"], {
      script: ["workflow-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 10");
    expect(run.stdout).toContain("Release pipeline");
  });

  it("workflow survey displays survey questions", async () => {
    const run = await runCli(["workflow", "survey", "10"], {
      script: ["workflow-survey"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("survey:");
    expect(run.stdout).toContain("Release Version");
  });

  it("workflow launch dry run issues no POST", async () => {
    const run = await runCli(["workflow", "launch", "10", "--dry-run"], {
      script: ["workflow-detail", "workflow-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("POST workflow_job_templates/10/launch/");
    expect(run.transport.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("workflow nodes displays full node graph", async () => {
    const run = await runCli(["workflow", "nodes", "1840"], {
      script: ["workflow-nodes"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("nodes");
    expect(run.stdout).toContain("Deploy web tier");
  });

  it("workflow create and edit support dry-run and --confirm", async () => {
    const dryCreate = await runCli(["workflow", "create", "New Pipeline"], { script: [] });
    expect(dryCreate.exitCode).toBe(0);
    expect(dryCreate.stdout).toContain("dry_run:");
    expect(dryCreate.stdout).toContain("would_send: POST workflow_job_templates/");

    const liveCreate = await runCli(["workflow", "create", "New Pipeline", "--confirm"], {
      script: [{ status: 201, body: { id: 15, name: "New Pipeline" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveCreate.exitCode).toBe(0);
    expect(liveCreate.stdout).toContain("id: 15");

    const dryEdit = await runCli(["workflow", "edit", "15", "--description", "Updated desc"], { script: [] });
    expect(dryEdit.exitCode).toBe(0);
    expect(dryEdit.stdout).toContain("would_send: PATCH workflow_job_templates/15/");

    const liveEdit = await runCli(["workflow", "edit", "15", "--description", "Updated desc", "--confirm"], {
      script: [{ status: 200, body: { id: 15, name: "New Pipeline" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveEdit.exitCode).toBe(0);
    expect(liveEdit.stdout).toContain("id: 15");
  });

  it("workflow delete supports dry-run and --confirm", async () => {
    const dryDelete = await runCli(["workflow", "delete", "10"], { script: [] });
    expect(dryDelete.exitCode).toBe(0);
    expect(dryDelete.stdout).toContain("dry_run:");
    expect(dryDelete.stdout).toContain("would_send: DELETE workflow_job_templates/10/");

    const liveDelete = await runCli(["workflow", "delete", "10", "--confirm"], {
      script: [{ status: 204 }],
      env: { AWX_AXI_ALLOW_DELETES: "1" },
    });
    expect(liveDelete.exitCode).toBe(0);
    expect(liveDelete.stdout).toContain("status: deleted");
    expect(liveDelete.transport.requests[0]).toMatchObject({
      method: "DELETE",
      route: "workflow_job_templates/10/",
    });
  });
});
