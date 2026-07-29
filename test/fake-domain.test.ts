import { describe, expect, it } from "vitest";

import { setWatchClock } from "./support/fake-domain.js";
import { runCli } from "./support/run.js";

/**
 * The request-declaration model, exercised against a fake domain defined in the
 * tests (design.md §10.2, §11.2).
 *
 * A subcommand is not one request: `show` is three, and `launch <name>` cannot
 * build its launch path until the resolve response comes back. The model is a
 * plan that yields request descriptions and is resumed with each result, so a
 * later route may depend on an earlier response while the domain still executes
 * nothing itself.
 */
describe("a multi-request read", () => {
  it("lets a later route depend on an earlier response", async () => {
    const run = await runCli(["gadget", "show", "1839"], {
      script: [
        {
          status: 200,
          body: {
            count: 1,
            results: [{ id: 1839, type: "job", name: "Deploy db tier" }],
          },
        },
        { status: 200, body: { id: 1839, name: "Deploy db tier", status: "failed" } },
        "job-events-page",
      ],
    });

    expect(run.exitCode).toBe(0);
    // Three requests, and the second route was built from the first response.
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "unified_jobs/",
      "jobs/1839/",
      "jobs/1839/job_events/",
    ]);
    expect(run.stdout).toContain("status: failed");
    expect(run.stdout).toContain("events: 231");
  });
});

describe("a resolve-then-write flow", () => {
  it("resolves the name, then builds the launch path from the resolved id", async () => {
    const run = await runCli(["gadget", "launch", "Deploy web tier"], {
      script: [
        "job-templates-name-one",
        "launch-preflight-accepts-limit",
        "launch-201-ignored-fields",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "job_templates/",
      query: { name: "Deploy web tier" },
    });
    expect(run.transport.requests[1]?.route).toBe("job_templates/12/launch/");
    expect(run.transport.requests[2]).toMatchObject({
      method: "POST",
      route: "job_templates/12/launch/",
    });
  });

  it("reports a silently ignored field as a warning at exit 0 (§4.3 case 6)", async () => {
    const run = await runCli(["gadget", "launch", "12", "--limit", "db-02"], {
      script: ["launch-preflight-accepts-limit", "launch-201-ignored-fields"],
    });

    // The job is running, so a non-zero exit would invite a relaunch (§7.5).
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 1844");
    expect(run.stdout).toContain("warning:");
    expect(run.stdout).toContain("ignored[1]{field,submitted}:");
    expect(run.stdout).toContain("limit,db-02");
    expect(run.stdout).toContain("awx-axi gadget cancel 1844");
  });

  it("refuses before the POST when the template would drop the field (§7.5)", async () => {
    const run = await runCli(["gadget", "launch", "18", "--limit", "db-02"], {
      script: ["launch-preflight-no-limit"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: LAUNCH_WOULD_IGNORE_INPUT");
    expect(run.stdout).toContain("ignored[1]{flag,reason}:");
    // One GET, and no POST at all.
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]?.method).toBe("GET");
  });
});

describe("the 405 disambiguation (design.md §9.2)", () => {
  it("costs exactly one follow-up read", async () => {
    const run = await runCli(["gadget", "cancel", "1839"], {
      script: ["cancel-405", "job-detail-terminal"],
    });

    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]?.method).toBe("POST");
    expect(run.transport.requests[1]?.method).toBe("GET");
  });

  it("cancel on a terminal job is an exit-0 no-op", async () => {
    const run = await runCli(["gadget", "cancel", "1839"], {
      script: ["cancel-405", "job-detail-terminal"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      "already finished (failed), nothing to cancel (no-op)",
    );
  });

  it("cancel on an active job is SERVER_ERROR at exit 1", async () => {
    const run = await runCli(["gadget", "cancel", "1841"], {
      script: ["cancel-405", "job-detail-active"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: SERVER_ERROR");
  });

  it("sync on a project already syncing is an exit-0 no-op naming the sync", async () => {
    const run = await runCli(["gadget", "sync", "4"], {
      script: ["cancel-405", "project-detail-syncing"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("already syncing as 1846 (no-op)");
  });

  it("sync on a project with no SCM source is SYNC_UNAVAILABLE at exit 1", async () => {
    const run = await runCli(["gadget", "sync", "7"], {
      script: ["cancel-405", "project-detail-no-scm"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: SYNC_UNAVAILABLE");
    expect(run.stdout).toContain("has no SCM source");
  });
});

describe("the read-only boundary reaches through the whole CLI (§6.5)", () => {
  it("refuses a launch and issues nothing", async () => {
    const run = await runCli(["gadget", "launch", "12", "--limit", "db-02"], {
      script: ["launch-preflight-accepts-limit"],
      env: { AWX_AXI_READ_ONLY: "1" },
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: READ_ONLY_VIOLATION");
    expect(run.stdout).toContain("POST job_templates/12/launch/");
    // The preflight GET happened; the POST never reached the transport.
    expect(
      run.transport.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);
  });
});

describe("the poll loop (design.md §7.9)", () => {
  it("stops when the status leaves AWX's active set", async () => {
    setWatchClock({ now: () => 0 });

    const run = await runCli(["gadget", "watch", "1843"], {
      script: [
        { status: 200, body: { id: 1843, status: "pending" } },
        { status: 200, body: { id: 1843, status: "running" } },
        { status: 200, body: { id: 1843, status: "failed" } },
      ],
    });

    // §7.9: the exit code follows the watched job, and the job block is still
    // rendered as output rather than as an error block.
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("status: failed");
    expect(run.stdout).toContain("polls: 3");
    expect(run.stdout).not.toContain("code:");
  });

  it("exits 0 when the watched job succeeded", async () => {
    setWatchClock({ now: () => 0 });

    const run = await runCli(["gadget", "watch", "1843"], {
      script: [
        { status: 200, body: { id: 1843, status: "running" } },
        { status: 200, body: { id: 1843, status: "successful" } },
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("status: successful");
  });

  it("surfaces a response with no status rather than reporting a completed run", async () => {
    setWatchClock({ now: () => 0 });

    const run = await runCli(["gadget", "watch", "1843"], {
      script: [{ status: 200, body: { id: 1843 } }],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("reported no status");
    expect(run.stdout).not.toContain("status: \n");
  });

  it("clamps the last wait to the remaining budget, so the timeout is a ceiling", async () => {
    let clock = 0;
    setWatchClock({ now: () => clock });

    const waits: number[] = [];
    const run = await runCli(["gadget", "watch", "1843", "--timeout", "12"], {
      script: [
        { status: 200, body: { id: 1843, status: "running" } },
        { status: 200, body: { id: 1843, status: "running" } },
        { status: 200, body: { id: 1843, status: "running" } },
      ],
      sleep: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    // 5s, then the remaining 7s of the 12s budget rather than a full 10s
    // backoff step that would overshoot it.
    expect(waits).toEqual([5_000, 7_000]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: WATCH_TIMEOUT");
  });

  it("gives up at the hard timeout rather than blocking unbounded", async () => {
    let clock = 0;
    setWatchClock({
      now: () => {
        const value = clock;
        clock += 400_000;
        return value;
      },
    });

    const run = await runCli(["gadget", "watch", "1843", "--timeout", "600"], {
      script: [
        { status: 200, body: { id: 1843, status: "running" } },
        { status: 200, body: { id: 1843, status: "running" } },
        { status: 200, body: { id: 1843, status: "running" } },
      ],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: WATCH_TIMEOUT");
    expect(run.stdout).toContain("awx-axi gadget watch 1843");
  });
});

describe("surplus positionals fail loud (design.md §9.4)", () => {
  it("refuses a second id rather than acting on the first alone", async () => {
    const run = await runCli(["gadget", "cancel", "1839", "1841"], {
      script: ["cancel-405"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    // The surplus argument is named, so the correction takes one turn.
    expect(run.stdout).toContain("1841");
    expect(run.stdout).toContain("awx-axi gadget cancel 1839");
    // And nothing was cancelled.
    expect(run.transport.requests).toHaveLength(0);
  });
});

describe("list output (design.md §8.2)", () => {
  it("carries the server's total and never a page boundary", async () => {
    const run = await runCli(["gadget", "list"], {
      script: [
        "unified-jobs-page-1",
        "unified-jobs-page-2",
        "unified-jobs-page-3",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("count: 450 of 512 total");
    expect(run.stdout).toContain("gadgets[450]{id,name,status}:");
  });
});
