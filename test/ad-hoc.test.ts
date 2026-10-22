import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("ad-hoc domain (design.md §7.2)", () => {
  it("ad-hoc list shows command run rows", async () => {
    const run = await runCli(["ad-hoc", "list"], {
      script: ["ad-hoc-list"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "ad_hoc_commands/",
      query: { page_size: 100 },
    });
    expect(run.stdout).toContain("count: 1 total");
    expect(run.stdout).toContain("ad_hoc_commands");
    expect(run.stdout).toContain("Gather host facts");
  });

  it("ad-hoc show displays command metadata", async () => {
    const run = await runCli(["ad-hoc", "show", "401"], {
      script: ["ad-hoc-show"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "ad_hoc_commands/401/",
    });
    expect(run.stdout).toContain("id: 401");
    expect(run.stdout).toContain("Gather host facts");
    expect(run.stdout).toContain("inventory: 5 (production)");
  });

  it("ad-hoc events lists command events", async () => {
    const run = await runCli(["ad-hoc", "events", "401"], {
      script: ["ad-hoc-events"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "ad_hoc_commands/401/events/",
      query: { page_size: 50 },
    });
    expect(run.stdout).toContain("events");
    expect(run.stdout).toContain("runner_on_ok");
  });

  it("ad-hoc stdout returns raw log with range header", async () => {
    const run = await runCli(["ad-hoc", "stdout", "401"], {
      script: ["ad-hoc-stdout"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "ad_hoc_commands/401/stdout/",
      query: { format: "txt" },
    });
    expect(run.stdout).toContain("ad_hoc_stdout:");
    expect(run.stdout).toContain("lines: 1-4 of 4");
    expect(run.stdout).toContain("PLAY [all]");
  });

  it("ad-hoc stdout supports line-range query", async () => {
    const run = await runCli(["ad-hoc", "stdout", "401", "--lines", "1-2"], {
      script: ["ad-hoc-stdout"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "ad_hoc_commands/401/stdout/",
      query: {
        format: "txt",
        start_line: 1,
        end_line: 2,
      },
    });
    expect(run.stdout).toContain("PLAY [all]");
  });

  it("ad-hoc stdout raises OUTPUT_TOO_LARGE on oversized apology", async () => {
    const run = await runCli(["ad-hoc", "stdout", "401"], {
      script: ["stdout-too-large"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: OUTPUT_TOO_LARGE");
    expect(run.stdout).toContain("display limit");
  });

  it("ad-hoc launch defaults to dry run without --confirm", async () => {
    const run = await runCli(["ad-hoc", "launch", "5", "--module-name", "ping"], {
      script: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("would_send: POST ad_hoc_commands/");
    expect(run.stdout).toContain("help[1]: Re-run with --confirm to launch");
  });

  it("ad-hoc launch executes live mutation request when --confirm is passed", async () => {
    const run = await runCli(["ad-hoc", "launch", "5", "--module-name", "ping", "--confirm"], {
      script: [{ status: 201, body: { id: 402, status: "pending" } }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 402");
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "ad_hoc_commands/",
      body: { inventory: 5, module_name: "ping", module_args: "" },
    });
  });
});
