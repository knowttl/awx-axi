import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("credential domain (design.md §identity)", () => {
  it("credential list follows pagination and supports organization filter", async () => {
    const run = await runCli([
      "credential",
      "list",
      "--organization",
      "1",
      "--limit",
      "2",
    ], {
      script: ["credential-list-page-1", "credential-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "credentials/",
      query: { organization: 1, page_size: 2 },
    });
    expect(run.stdout).toContain("credentials[2]{id,name,organization,credential_type,managed}:");
    expect(run.stdout).toContain("prod-ssh");
  });

  it("credential show by id omits secret fields", async () => {
    const run = await runCli(["credential", "show", "101"], {
      script: ["credential-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("credential:");
    expect(run.stdout).toContain("id: 101");
    expect(run.stdout).toContain("name: prod-ssh");
    expect(run.stdout).not.toContain("inputs:");
    expect(run.stdout).not.toContain("private_key");
    expect(run.stdout).not.toContain("$encrypted$");
    expect(run.stdout).not.toContain("s3cr3t");
  });

  it("credential show resolves by name and handles no match", async () => {
    const run = await runCli(["credential", "show", "prod-ssh"], {
      script: ["credential-name-one", "credential-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "credentials/",
      query: { name: "prod-ssh" },
    });
    expect(run.stdout).toContain("id: 101");
    expect(run.stdout).toContain("organization: 1 (Operations)");
  });

  it("credential show with missing name reports NAME_NOT_FOUND", async () => {
    const run = await runCli(["credential", "show", "missing"], {
      script: ["credential-name-none", "credential-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.transport.requests).toHaveLength(2);
  });
});
