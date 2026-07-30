import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("system-job list, show, events, and notifications", () => {
  it("lists system jobs with optional filters", async () => {
    const run = await runCli([
      "system-job",
      "list",
      "--template",
      "301",
      "--status",
      "failed",
      "--limit",
      "2",
    ], {
      script: ["system-job-list"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "system_jobs/",
      query: {
        unified_job_template: 301,
        status: "failed",
        page_size: 2,
      },
    });
    expect(run.stdout).toContain("system_jobs[2]{id,name,template,status,type,started,finished}:");
    expect(run.stdout).toContain("Run `awx-axi system-job show <id>` for job details");
  });

  it("shows system job detail after unified-job type resolution", async () => {
    const run = await runCli([
      "system-job",
      "show",
      "901",
    ], {
      script: ["system-job-resolve", "system-job-show"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "unified_jobs/",
      query: { id: 901 },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "system_jobs/901/",
    });
    expect(run.stdout).toContain("system_job:");
    expect(run.stdout).toContain("id: 901");
    expect(run.stdout).toContain("name: Cleanup stale sessions run");
  });

  it("reads system job events with filters", async () => {
    const run = await runCli([
      "system-job",
      "events",
      "901",
      "--failed",
      "--host",
      "controller",
      "--limit",
      "1",
    ], {
      script: ["system-job-resolve", "system-job-events"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "system_jobs/901/events/",
      query: {
        failed: true,
        host_name: "controller",
        page_size: 1,
      },
    });
    expect(run.stdout).toContain("events[1]{id,event,host,task,failed,changed}:");
    expect(run.stdout).toContain("Run `awx-axi system-job show 901` for run-level status");
  });

  it("lists system job notifications", async () => {
    const run = await runCli([
      "system-job",
      "notifications",
      "901",
      "--limit",
      "2",
    ], {
      script: ["system-job-resolve", "system-job-notifications"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "system_jobs/901/notifications/",
      query: {
        page_size: 2,
      },
    });
    expect(run.stdout).toContain("notifications[2]{id,template,status,created,errors,subject}:");
    expect(run.stdout).toContain("Run `awx-axi system-job show 901` for run-level status");
  });
});
