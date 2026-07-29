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
});
