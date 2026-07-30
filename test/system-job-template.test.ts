import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("system-job-template list and show", () => {
  it("lists templates with compact rows", async () => {
    const run = await runCli([
      "system-job-template",
      "list",
      "--search",
      "Cleanup",
      "--limit",
      "2",
    ], {
      script: ["system-job-template-list"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "system_job_templates/",
      query: {
        search: "Cleanup",
        page_size: 2,
      },
    });
    expect(run.stdout).toContain("system_job_templates[2]{id,name,type,status,last_run}:");
    expect(run.stdout).toContain("Run `awx-axi system-job-template show <id|name>` to inspect template detail");
  });

  it("shows template detail with related jobs and schedules", async () => {
    const run = await runCli([
      "system-job-template",
      "show",
      "Cleanup stale sessions",
    ], {
      script: [
        "system-job-template-name-one",
        "system-job-template-show",
        "system-job-template-jobs",
        "system-job-template-schedules",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(4);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "system_job_templates/",
      query: {
        name: "Cleanup stale sessions",
      },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "system_job_templates/301/",
    });
    expect(run.transport.requests[2]).toMatchObject({
      method: "GET",
      route: "system_job_templates/301/jobs/",
    });
    expect(run.transport.requests[3]).toMatchObject({
      method: "GET",
      route: "system_job_templates/301/schedules/",
    });

    expect(run.stdout).toContain("system_job_template:");
    expect(run.stdout).toContain("name: Cleanup stale sessions");
    expect(run.stdout).toContain("jobs[2]{id,name,status,template,started,finished}:");
    expect(run.stdout).toContain("schedules[2]{id,name,enabled,next_run}:");
    expect(run.stdout).toContain("Run `awx-axi system-job list --template 301` to inspect recent system jobs");
  });
});
