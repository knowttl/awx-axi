import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("activity-stream list", () => {
  it("reads compact activity pages from /activity_stream/", async () => {
    const run = await runCli(["activity-stream", "list", "--operation", "create", "--search", "project"], {
      script: ["activity-stream-list"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "activity_stream/",
      query: { operation: "create", search: "project", page_size: 100 },
    });

    expect(run.stdout).toContain('activity_stream[2]{id,operation,object_type,object1,object2,timestamp}:');
    expect(run.stdout).toContain("create");
  });

  it("supports resource scope flags by writing query filters", async () => {
    const run = await runCli(["activity-stream", "list", "--job", "1839", "--workflow", "7"], {
      script: ["activity-stream-empty"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("supports one resource scope flag at a time", async () => {
    const run = await runCli(["activity-stream", "list", "--job", "1839"], {
      script: ["activity-stream-list"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "activity_stream/",
      query: { job: 1839, page_size: 100 },
    });
    expect(run.stdout).toContain("9001,create,project");
  });

  it("rejects invalid operation values", async () => {
    const run = await runCli(["activity-stream", "list", "--operation", "bad"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("--operation for `activity-stream list`");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("shows an explicit empty state", async () => {
    const run = await runCli(["activity-stream", "list", "--job", "999999"], {
      script: ["activity-stream-empty"],
    });

    expect(run.stdout).toContain("0 activity_stream entries found");
  });
});

describe("activity-stream show", () => {
  it("reads one activity-stream entry and redacts sensitive payload", async () => {
    const run = await runCli(["activity-stream", "show", "9001"], {
      script: ["activity-stream-show"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "activity_stream/9001/",
    });
    expect(run.stdout).toContain('"activity-stream":');
    expect(run.stdout).toContain("operation: create");
    expect(run.stdout).not.toContain("https://user:secret@github.com");
    expect(run.stdout).toContain("https://***@github.com/ansible/infra");
    expect(run.stdout).toContain("changes:");
  });

  it("requires a numeric id", async () => {
    const run = await runCli(["activity-stream", "show", "bad-id"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
  });
});
