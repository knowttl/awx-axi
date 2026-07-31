import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

/**
 * The `approval` domain (design.md §7.7): the inbox of decisions waiting on a
 * human - list, show, approve, and deny. Driven end to end through the CLI
 * against `RecordedTransport`, offline, with no network and no mocking
 * framework (§10.2, §11.2).
 */
describe("approval list (design.md §7.7)", () => {
  it("defaults to pending only and reports the server's total", async () => {
    const run = await runCli(["approval", "list"], {
      script: ["approval-list-pending"],
    });

    expect(run.exitCode).toBe(0);
    // §7.7: `approval list` defaults to pending only.
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "workflow_approvals/",
      query: { status: "pending", page_size: 20 },
    });
    expect(run.stdout).toContain("count: 2 total");
    expect(run.stdout).toContain("approvals[2]{id,name,workflow,status}:");
    expect(run.stdout).toContain("57,Prod release gate,Release pipeline,pending");
    expect(run.stdout).toContain("awx-axi approval show <id>");
  });

  it("drops the pending filter under --all", async () => {
    const run = await runCli(["approval", "list", "--all"], {
      script: ["approval-list-pending"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toEqual({ page_size: 20 });
  });

  it("states the definitive empty inbox and points at --all", async () => {
    const run = await runCli(["approval", "list"], {
      script: ["approval-list-empty"],
    });

    expect(run.exitCode).toBe(0);
    // AXI §5: the zero is stated with the filter that produced it.
    expect(run.stdout).toContain("approvals: 0 approvals pending");
    expect(run.stdout).toContain("awx-axi approval list --all");
  });

  it("honors --limit as a row count", async () => {
    const run = await runCli(["approval", "list", "--limit", "5"], {
      script: ["approval-list-pending"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toMatchObject({ page_size: 5 });
  });

  it("rejects a non-positive --limit before any read (§9.1)", async () => {
    const run = await runCli(["approval", "list", "--limit", "0"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("rejects an unknown flag by name (§9.4)", async () => {
    const run = await runCli(["approval", "list", "--status", "pending"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("unknown flag --status for `approval list`");
    expect(run.transport.requests).toHaveLength(0);
  });
});

describe("approval show (design.md §7.7)", () => {
  it("prints the approval, the workflow, and the downstream steps it gates", async () => {
    const run = await runCli(["approval", "show", "57"], {
      script: ["approval-detail", "workflow-nodes"],
    });

    expect(run.exitCode).toBe(0);
    // Two reads for a numeric id: the detail, then the workflow's node list
    // that `blocks` is derived from (§7.7).
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "workflow_approvals/57/",
      "workflow_jobs/1840/workflow_nodes/",
    ]);
    expect(run.stdout).toContain("id: 57");
    expect(run.stdout).toContain("name: Prod release gate");
    expect(run.stdout).toContain("1840 (Release pipeline)");
    expect(run.stdout).toContain("status: pending");
    expect(run.stdout).toContain("requested: ");
    expect(run.stdout).toContain("timeout: 3600");
    expect(run.stdout).toContain("expires: ");
    // The node's success and always edges are the steps it releases (§7.7).
    expect(run.stdout).toContain("blocks[2]{node,template}:");
    expect(run.stdout).toContain("9,Deploy web tier");
    expect(run.stdout).toContain("10,Smoke test");
    // The help count is derived from the gated steps, not hard-coded.
    expect(run.stdout).toContain(
      "Run `awx-axi approval approve 57` to release the 2 downstream steps",
    );
    expect(run.stdout).toContain("awx-axi approval deny 57");
  });
});

describe("approval show resolves a name (design.md §7.3)", () => {
  it("one match resolves, then reads the detail and the node list", async () => {
    const run = await runCli(["approval", "show", "Prod release gate"], {
      script: ["approval-name-one", "approval-detail", "workflow-nodes"],
    });

    expect(run.exitCode).toBe(0);
    // The resolve is a filtered query, never a named URL (§7.3).
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "workflow_approvals/",
      query: { name: "Prod release gate" },
    });
    expect(run.transport.requests[1]?.route).toBe("workflow_approvals/57/");
    expect(run.stdout).toContain("id: 57");
  });

  it("zero matches is NAME_NOT_FOUND after the iexact fallback (§7.3)", async () => {
    const run = await runCli(["approval", "show", "no such gate"], {
      script: ["approval-name-none", "approval-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    // Exact match, then the case-insensitive fallback: two resolve reads (§7.10).
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]?.query).toEqual({ name: "no such gate" });
    expect(run.transport.requests[1]?.query).toEqual({
      name__iexact: "no such gate",
    });
  });

  it("more than one match is AMBIGUOUS_NAME with candidates, never a guess (§7.3)", async () => {
    const run = await runCli(["approval", "show", "Prod release gate"], {
      script: ["approval-name-ambiguous"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(run.stdout).toContain("candidates");
    expect(run.stdout).toContain("57");
    expect(run.stdout).toContain("88");
    // It refused before reading any detail: only the one filtered query ran.
    expect(run.transport.requests).toHaveLength(1);
  });
});

describe("the read surface issues only reads", () => {
  it("makes no POST, so the read-only boundary never trips (§6.5)", async () => {
    const run = await runCli(["approval", "show", "57"], {
      script: ["approval-detail", "workflow-nodes"],
      env: { AWX_AXI_READ_ONLY: "1" },
    });

    expect(run.exitCode).toBe(0);
    expect(
      run.transport.requests.every((request) => request.method === "GET"),
    ).toBe(true);
  });
});

describe("approval approve and deny (design.md §7.7)", () => {
  it("approval approve dry run issues no POST", async () => {
    const run = await runCli(["approval", "approve", "57", "--dry-run"], {
      script: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("POST workflow_approvals/57/approve/");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("approval approve posts to approve endpoint", async () => {
    const run = await runCli(["approval", "approve", "57", "--confirm"], {
      script: ["approval-approve-204"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 57");
    expect(run.stdout).toContain("status: approved");
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "workflow_approvals/57/approve/",
    });
  });

  it("approval deny posts to deny endpoint", async () => {
    const run = await runCli(["approval", "deny", "57", "--confirm"], {
      script: ["approval-deny-204"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 57");
    expect(run.stdout).toContain("status: denied");
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "workflow_approvals/57/deny/",
    });
  });
});
