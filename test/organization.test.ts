import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("organization domain (design.md §identity)", () => {
  it("organization list follows pagination and uses filters", async () => {
    const run = await runCli(["organization", "list", "--limit", "2"], {
      script: ["organization-list-page-1", "organization-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "organizations/",
      query: { page_size: 2 },
    });
    expect(run.stdout).toContain("count: 2 of 3 total");
    expect(run.stdout).toContain("organizations[2]{id,name,max_hosts,users,projects}:");
    expect(run.stdout).toContain("Operations");
  });

  it("organization list accepts search", async () => {
    const run = await runCli([
      "organization",
      "list",
      "--search",
      "prod",
    ], {
      script: ["organization-list-page-1", "organization-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toMatchObject({ search: "prod" });
  });

  it("organization show by id displays detail", async () => {
    const run = await runCli(["organization", "show", "1"], {
      script: ["organization-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("organization:");
    expect(run.stdout).toContain("id: 1");
    expect(run.stdout).toContain("name: Operations");
    expect(run.stdout).toContain("users: 3");
  });

  it("organization show resolves by name and follows fallback lookup", async () => {
    const run = await runCli(["organization", "show", "Operations"], {
      script: ["organization-name-one", "organization-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "organizations/",
      query: { name: "Operations" },
    });
    expect(run.stdout).toContain("name: Operations");
  });

  it("organization show with missing name reports NAME_NOT_FOUND", async () => {
    const run = await runCli(["organization", "show", "Unknown"], {
      script: ["organization-name-none", "organization-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.transport.requests).toHaveLength(2);
    expect(run.stdout).toContain(
      'Run `awx-axi organization list --search \\"Unknown\\"` to search by partial name',
    );
  });
});
