import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("notification list", () => {
  it("uses a paginated GET against /notifications/", async () => {
    const run = await runCli(
      ["notification", "list", "--status", "failed", "--limit", "2", "--search", "deploy"],
      {
        script: ["notification-list"],
      },
    );

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "notifications/",
      query: { status: "failed", search: "deploy", page_size: 2 },
    });
    expect(run.stdout).toContain("notifications[2]{id,notification_type,status,template,created}:");
    expect(run.exitCode).toBe(0);
  });

  it("supports status=all by dropping status filter", async () => {
    const run = await runCli(["notification", "list", "--status", "all"], {
      script: ["notification-list"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "notifications/",
      query: { page_size: 100 },
    });
    expect(run.exitCode).toBe(0);
  });

  it("supports job-scoped routes for notification lookup", async () => {
    const run = await runCli(["notification", "list", "--job", "1839"], {
      script: ["notification-job-list"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "jobs/1839/notifications/",
      query: { page_size: 100 },
    });
    expect(run.stdout).toContain("notifications[1]{id,notification_type,status,template,created}:");
  });

  it("rejects invalid status filters", async () => {
    const run = await runCli(["notification", "list", "--status", "oops"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("--status for `notification list`");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("rejects a non-positive --template before any read", async () => {
    const run = await runCli(["notification", "list", "--template", "0"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("--template");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("prints an explicit empty state", async () => {
    const run = await runCli(["notification", "list", "--status", "all", "--search", "none"], {
      script: ["notification-list-empty"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("0 notifications found");
  });
});

describe("notification show", () => {
  it("requires a numeric id", async () => {
    const run = await runCli(["notification", "show", "name"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
  });

  it("reads notification detail and redacts urls and encrypted markers", async () => {
    const run = await runCli(["notification", "show", "101"], {
      script: ["notification-show"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "notifications/101/",
    });
    expect(run.stdout).toContain("notification:");
    expect(run.stdout).toContain("status: failed");
    expect(run.stdout).not.toContain("secret-token");
    expect(run.stdout).toContain("$encrypted$");
    expect(run.stdout).toContain("body:");
  });

  it("still blocks writes when AWX_AXI_READ_ONLY=1", async () => {
    const run = await runCli(["notification", "show", "101"], {
      script: ["notification-show"],
      env: { AWX_AXI_READ_ONLY: "1" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
