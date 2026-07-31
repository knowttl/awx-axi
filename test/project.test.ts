import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("project domain (design.md §7.8)", () => {
  it("project list lists projects", async () => {
    const run = await runCli(["project", "list"], {
      script: ["project-list"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("count: 1 total");
    expect(run.stdout).toContain("projects");
    expect(run.stdout).toContain("infra-playbooks");
  });

  it("project show displays detail", async () => {
    const run = await runCli(["project", "show", "4"], {
      script: ["project-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 4");
    expect(run.stdout).toContain("infra-playbooks");
    expect(run.stdout).toContain("scm_type: git");
  });

  it("project playbooks lists playbooks in checkout", async () => {
    const run = await runCli(["project", "playbooks", "4"], {
      script: ["project-playbooks"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("playbooks");
    expect(run.stdout).toContain("deploy/web.yml");
  });

  it("project updates lists recent sync jobs", async () => {
    const run = await runCli(["project", "updates", "4"], {
      script: ["project-updates"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("updates");
    expect(run.stdout).toContain("infra-playbooks update");
  });

  it("project roles lists object roles for access metadata", async () => {
    const run = await runCli(["project", "roles", "4"], {
      script: ["project-object-roles"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "projects/4/object_roles/",
      query: { page_size: 100 },
    });
    expect(run.stdout).toContain("roles");
    expect(run.stdout).toContain("project_admin");
  });

  it("project sync dry run issues no POST", async () => {
    const run = await runCli(["project", "sync", "4", "--dry-run"], {
      script: ["project-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("POST projects/4/update/");
    expect(run.transport.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("project sync handles 405 on non-SCM project as SYNC_UNAVAILABLE (§9.2)", async () => {
    const run = await runCli(["project", "sync", "4", "--confirm"], {
      script: ["cancel-405", "project-detail-no-scm"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: SYNC_UNAVAILABLE");
    expect(run.stdout).toContain("this project has no SCM source to sync from");
  });

  it("project sync handles 405 on already syncing project as exit 0 no-op (§9.2)", async () => {
    const run = await runCli(["project", "sync", "4", "--confirm"], {
      script: ["cancel-405", "project-detail-syncing"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("sync already running for project 4");
  });

  it("project create and edit support dry-run and --confirm", async () => {
    const dryCreate = await runCli(["project", "create", "New Project", "--scm-type", "git"], { script: [] });
    expect(dryCreate.exitCode).toBe(0);
    expect(dryCreate.stdout).toContain("dry_run:");
    expect(dryCreate.stdout).toContain("would_send: POST projects/");

    const liveCreate = await runCli(["project", "create", "New Project", "--scm-type", "git", "--confirm"], {
      script: [{ status: 201, body: { id: 8, name: "New Project", scm_type: "git" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveCreate.exitCode).toBe(0);
    expect(liveCreate.stdout).toContain("id: 8");

    const dryEdit = await runCli(["project", "edit", "8", "--scm-branch", "main"], { script: [] });
    expect(dryEdit.exitCode).toBe(0);
    expect(dryEdit.stdout).toContain("would_send: PATCH projects/8/");

    const liveEdit = await runCli(["project", "edit", "8", "--scm-branch", "main", "--confirm"], {
      script: [{ status: 200, body: { id: 8, name: "New Project" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveEdit.exitCode).toBe(0);
    expect(liveEdit.stdout).toContain("id: 8");
  });
});
