import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("role domain (design.md §rbac)", () => {
  it("role list follows pagination and uses filters", async () => {
    const run = await runCli(["role", "list", "--limit", "2"], {
      script: ["role-list-page-1", "role-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "roles/",
      query: { page_size: 2 },
    });
    expect(run.stdout).toContain("count: 2 of 3 total");
    expect(run.stdout).toContain("roles[2]{id,name,type,resource_name}:");
    expect(run.stdout).toContain("Admin");
    expect(run.stdout).toContain("Member");
  });

  it("role list accepts search and type filters", async () => {
    const run = await runCli(["role", "list", "--search", "admin", "--type", "team"], {
      script: ["role-list-page-1", "role-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toMatchObject({
      search: "admin",
      type: "team",
    });
  });

  it("role show by id displays detail", async () => {
    const run = await runCli(["role", "show", "10"], {
      script: ["role-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("role:");
    expect(run.stdout).toContain("id: 10");
    expect(run.stdout).toContain("name: Admin");
    expect(run.stdout).toContain("type: team");
    expect(run.stdout).toContain("resource_name: Engineering");
    expect(run.stdout).toContain("parents: 1");
    expect(run.stdout).toContain("children: 1");
    expect(run.stdout).toContain("users: 2");
    expect(run.stdout).toContain("teams: 1");
  });

  it("role show resolves by name", async () => {
    const run = await runCli(["role", "show", "Admin"], {
      script: ["role-name-one", "role-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "roles/",
      query: { name: "Admin" },
    });
    expect(run.stdout).toContain("name: Admin");
  });

  it("role show with missing name reports NAME_NOT_FOUND", async () => {
    const run = await runCli(["role", "show", "Unknown"], {
      script: ["role-name-none", "role-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.transport.requests).toHaveLength(2);
    expect(run.stdout).toContain(
      'Run `awx-axi role list --search \\"Unknown\\"` to search by partial name',
    );
  });

  it("role parents lists parent roles", async () => {
    const run = await runCli(["role", "parents", "10"], {
      script: ["role-parents"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "roles/10/parents/",
    });
    expect(run.stdout).toContain("parents[1]{id,name,type,description}:");
    expect(run.stdout).toContain("Admin");
  });

  it("role children lists child roles", async () => {
    const run = await runCli(["role", "children", "10"], {
      script: ["role-children"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "roles/10/children/",
    });
    expect(run.stdout).toContain("children[1]{id,name,type,description}:");
    expect(run.stdout).toContain("Member");
  });

  it("role users lists assigned users", async () => {
    const run = await runCli(["role", "users", "10"], {
      script: ["role-users"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "roles/10/users/",
    });
    expect(run.stdout).toContain("users[2]{id,username,first_name,last_name,email}:");
    expect(run.stdout).toContain("awx");
    expect(run.stdout).toContain("alice");
  });

  it("role teams lists assigned teams", async () => {
    const run = await runCli(["role", "teams", "10"], {
      script: ["role-teams"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "roles/10/teams/",
    });
    expect(run.stdout).toContain("teams[1]{id,name,organization,description}:");
    expect(run.stdout).toContain("Engineering");
  });

  it("role grant and revoke support dry-run and --confirm", async () => {
    const dryGrant = await runCli(["role", "grant", "10", "--user", "11"], { script: [] });
    expect(dryGrant.exitCode).toBe(0);
    expect(dryGrant.stdout).toContain("dry_run:");
    expect(dryGrant.stdout).toContain("would_send: POST roles/10/users/");

    const liveGrant = await runCli(["role", "grant", "10", "--user", "11", "--confirm"], {
      script: [{ status: 204 }],
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
    });
    expect(liveGrant.exitCode).toBe(0);
    expect(liveGrant.stdout).toContain("status: granted");

    const dryRevoke = await runCli(["role", "revoke", "10", "--team", "5"], { script: [] });
    expect(dryRevoke.exitCode).toBe(0);
    expect(dryRevoke.stdout).toContain("dry_run:");
    expect(dryRevoke.stdout).toContain("would_send: POST roles/10/teams/");

    const liveRevoke = await runCli(["role", "revoke", "10", "--team", "5", "--confirm"], {
      script: [{ status: 204 }],
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
    });
    expect(liveRevoke.exitCode).toBe(0);
    expect(liveRevoke.stdout).toContain("status: revoked");
  });
});
