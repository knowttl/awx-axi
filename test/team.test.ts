import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("team domain (design.md §rbac)", () => {
  it("team list follows pagination and uses filters", async () => {
    const run = await runCli(["team", "list", "--limit", "2"], {
      script: ["team-list-page-1", "team-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/",
      query: { page_size: 2 },
    });
    expect(run.stdout).toContain("count: 2 of 3 total");
    expect(run.stdout).toContain("teams[2]{id,name,organization,description}:");
    expect(run.stdout).toContain("Engineering");
    expect(run.stdout).toContain("Operations");
  });

  it("team list accepts search and organization filters", async () => {
    const run = await runCli(
      ["team", "list", "--search", "eng", "--organization", "1"],
      {
        script: ["team-list-page-1", "team-list-page-2"],
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toMatchObject({
      search: "eng",
      organization: 1,
    });
  });

  it("team list rejects invalid organization filter", async () => {
    const run = await runCli(["team", "list", "--organization", "invalid"]);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain(
      'error: "--organization must be a positive integer for `team list`, got invalid"',
    );
  });

  it("team show by id displays detail", async () => {
    const run = await runCli(["team", "show", "5"], {
      script: ["team-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("team:");
    expect(run.stdout).toContain("id: 5");
    expect(run.stdout).toContain("name: Engineering");
    expect(run.stdout).toContain("organization: 1 (Operations)");
    expect(run.stdout).toContain("users: 4");
    expect(run.stdout).toContain("projects: 2");
    expect(run.stdout).toContain("credentials: 1");
    expect(run.stdout).toContain("roles: 3");
  });

  it("team show resolves by name", async () => {
    const run = await runCli(["team", "show", "Engineering"], {
      script: ["team-name-one", "team-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/",
      query: { name: "Engineering" },
    });
    expect(run.stdout).toContain("name: Engineering");
  });

  it("team show with missing name reports NAME_NOT_FOUND", async () => {
    const run = await runCli(["team", "show", "Unknown"], {
      script: ["team-name-none", "team-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.transport.requests).toHaveLength(2);
    expect(run.stdout).toContain(
      'Run `awx-axi team list --search \\"Unknown\\"` to search by partial name',
    );
  });

  it("team users lists member users", async () => {
    const run = await runCli(["team", "users", "5"], {
      script: ["team-users"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/5/users/",
    });
    expect(run.stdout).toContain("users[2]{id,username,first_name,last_name,email}:");
    expect(run.stdout).toContain("awx");
    expect(run.stdout).toContain("alice");
  });

  it("team projects lists associated projects", async () => {
    const run = await runCli(["team", "projects", "5"], {
      script: ["team-projects"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/5/projects/",
    });
    expect(run.stdout).toContain("projects[1]{id,name,scm_type,status}:");
    expect(run.stdout).toContain("Web App");
  });

  it("team credentials lists associated credentials", async () => {
    const run = await runCli(["team", "credentials", "5"], {
      script: ["team-credentials"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/5/credentials/",
    });
    expect(run.stdout).toContain("credentials[1]{id,name,credential_type,managed}:");
    expect(run.stdout).toContain("K8s Token");
  });

  it("team roles lists assigned roles", async () => {
    const run = await runCli(["team", "roles", "5"], {
      script: ["team-roles"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/5/roles/",
    });
    expect(run.stdout).toContain("roles[2]{id,name,type,description}:");
    expect(run.stdout).toContain("Admin");
  });

  it("team object-roles lists assigned object roles", async () => {
    const run = await runCli(["team", "object-roles", "5"], {
      script: ["team-object-roles"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/5/object_roles/",
    });
    expect(run.stdout).toContain("object_roles[1]{id,name,type,description}:");
    expect(run.stdout).toContain("Execute");
  });

  it("team access-list lists access members", async () => {
    const run = await runCli(["team", "access-list", "5"], {
      script: ["team-access-list"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "teams/5/access_list/",
    });
    expect(run.stdout).toContain("access_list[2]{id,username,first_name,last_name,email}:");
    expect(run.stdout).toContain("awx");
  });

  it("team create, edit, delete support dry-run and --confirm", async () => {
    const dryCreate = await runCli(["team", "create", "DevOps", "--organization", "1"], { script: [] });
    expect(dryCreate.exitCode).toBe(0);
    expect(dryCreate.stdout).toContain("dry_run:");
    expect(dryCreate.stdout).toContain("would_send: POST teams/");

    const liveCreate = await runCli(["team", "create", "DevOps", "--organization", "1", "--confirm"], {
      script: [{ status: 201, body: { id: 6, name: "DevOps" } }],
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
    });
    expect(liveCreate.exitCode).toBe(0);
    expect(liveCreate.stdout).toContain("id: 6");

    const dryEdit = await runCli(["team", "edit", "6", "--description", "Updated desc"], { script: [] });
    expect(dryEdit.exitCode).toBe(0);
    expect(dryEdit.stdout).toContain("would_send: PATCH teams/6/");

    const liveEdit = await runCli(["team", "edit", "6", "--description", "Updated desc", "--confirm"], {
      script: [{ status: 200, body: { id: 6, name: "DevOps" } }],
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
    });
    expect(liveEdit.exitCode).toBe(0);
    expect(liveEdit.stdout).toContain("id: 6");

    const dryDelete = await runCli(["team", "delete", "6"], { script: [] });
    expect(dryDelete.exitCode).toBe(0);
    expect(dryDelete.stdout).toContain("would_send: DELETE teams/6/");

    const liveDelete = await runCli(["team", "delete", "6", "--confirm"], {
      script: [{ status: 204 }],
      env: { AWX_AXI_ALLOW_DELETES: "1" },
    });
    expect(liveDelete.exitCode).toBe(0);
    expect(liveDelete.stdout).toContain("status: deleted");
  });
});
