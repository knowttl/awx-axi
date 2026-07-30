import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("user domain (design.md §identity)", () => {
  it("user list follows pagination", async () => {
    const run = await runCli(["user", "list", "--limit", "2"], {
      script: ["user-list-page-1", "user-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "users/",
      query: { page_size: 2 },
    });
    expect(run.stdout).toContain("users[2]{id,username,first_name,last_name,email,is_superuser,is_system_auditor}:");
    expect(run.stdout).toContain("awx");
  });

  it("user show by id displays identity fields", async () => {
    const run = await runCli(["user", "show", "11"], {
      script: ["user-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("user:");
    expect(run.stdout).toContain("id: 11");
    expect(run.stdout).toContain("username: awx");
    expect(run.stdout).toContain("external_account: false");
    expect(run.stdout).not.toContain("password");
  });

  it("user show resolves by name and returns the username", async () => {
    const run = await runCli(["user", "show", "awx"], {
      script: ["user-name-one", "user-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "users/",
      query: { username: "awx" },
    });
    expect(run.stdout).toContain("username: awx");
  });

  it("user show reports missing-name with fallback fallback lookup", async () => {
    const run = await runCli(["user", "show", "no such user"], {
      script: ["user-name-none", "user-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.transport.requests).toHaveLength(2);
  });
});
