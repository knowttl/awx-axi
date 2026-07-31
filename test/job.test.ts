import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("job domain (design.md §7.2)", () => {
  it("job list lists unified jobs with status and envelope total", async () => {
    const run = await runCli(["job", "list"], {
      script: ["unified-jobs-page-1"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "unified_jobs/",
      query: { type: "job", page_size: 20 },
    });
    expect(run.stdout).toContain("count: 20 of 512 total");
    expect(run.stdout).toContain("jobs[20]{id,name,type,status,finished,created,started,elapsed,failed,launched_by,template}:");
    expect(run.stdout).toContain("1001,Deploy web tier #1001,job,failed");
  });

  it("job list filters by status and type", async () => {
    const run = await runCli(["job", "list", "--status", "failed", "--type", "all"], {
      script: ["unified-jobs-page-1"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toEqual({ status: "failed", page_size: 20 });
  });

  it("job list rejects unknown status with VALIDATION_ERROR", async () => {
    const run = await runCli(["job", "list", "--status", "invalid"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("unknown --status \\\"invalid\\\"");
  });

  it("job show resolves type and displays host rollup and failure detail", async () => {
    const run = await runCli(["job", "show", "1839", "--type", "job"], {
      script: ["job-detail-terminal", "job-host-summaries", "job-events-page", "stdout-ranged"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 1839");
    expect(run.stdout).toContain("type: job");
    expect(run.stdout).toContain("Deploy db tier");
    expect(run.stdout).toContain("status: failed");
    expect(run.stdout).toContain("hosts: \"3 total, 8 ok, 1 failed, 0 unreachable\"");
  });

  it("job show --type job skips unified_jobs type lookup", async () => {
    const run = await runCli(["job", "show", "1839", "--type", "job"], {
      script: ["job-detail-terminal", "job-host-summaries", "job-events-page", "stdout-ranged"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.route).toBe("jobs/1839/");
  });

  it("job stdout renders raw log region with line range header", async () => {
    const run = await runCli(["job", "stdout", "1839", "--type", "job"], {
      script: ["stdout-ranged"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("job_stdout:");
    expect(run.stdout).toContain("lines: 4013-4212 of 4212");
    expect(run.stdout).toContain("stdout:");
    expect(run.stdout).toContain("PLAY [all]");
  });

  it("job stdout raises OUTPUT_TOO_LARGE on oversized apology response", async () => {
    const run = await runCli(["job", "stdout", "1839", "--type", "job"], {
      script: ["stdout-too-large"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: OUTPUT_TOO_LARGE");
    expect(run.stdout).toContain("display limit");
  });

  it("job events lists job events", async () => {
    const run = await runCli(["job", "events", "1839", "--failed"], {
      script: ["job-events-page"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("events");
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "jobs/1839/job_events/",
      query: { failed: true, page_size: 50 },
    });
  });

  it("job hosts displays host rollup table", async () => {
    const run = await runCli(["job", "hosts", "1839"], {
      script: ["job-host-summaries"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("hosts");
    expect(run.stdout).toContain("db-01");
  });

  it("job cancel performs dry run", async () => {
    const run = await runCli(["job", "cancel", "1839", "--type", "job", "--dry-run"], {
      script: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("POST jobs/1839/cancel/");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("job cancel handles 405 on terminal job as exit 0 no-op (§9.2)", async () => {
    const run = await runCli(["job", "cancel", "1839", "--type", "job", "--confirm"], {
      script: ["cancel-405", "job-detail-terminal"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("1839 already finished (failed), nothing to cancel (no-op)");
  });

  it("job relaunch launches new job run", async () => {
    const run = await runCli(["job", "relaunch", "1839", "--type", "job", "--confirm"], {
      script: [{ status: 201, body: { id: 1845, name: "Deploy db tier", status: "pending" } }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 1845");
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "jobs/1839/relaunch/",
    });
  });

  it("job watch polls job detail to completion", async () => {
    const run = await runCli(["job", "watch", "1839", "--type", "job"], {
      script: [
        { status: 200, body: { id: 1839, name: "Deploy db tier", status: "running" } },
        { status: 200, body: { id: 1839, name: "Deploy db tier", status: "successful", elapsed: 42 } },
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("status: successful");
    expect(run.stdout).toContain("elapsed: 42");
  });
});
