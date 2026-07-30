import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("notification-template list", () => {
  it("defaults to a compact list with count from the envelope", async () => {
    const run = await runCli(["notification-template", "list", "--limit", "2"], {
      script: ["notification-template-list"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "notification_templates/",
      query: { page_size: 2 },
    });
    expect(run.stdout).toContain('"notification-templates"[2]{id,name,organization,notification_type,created}:');
    expect(run.stdout).toContain("email-ops");
  });

  it("searches by organization and supports statusless filtering flags", async () => {
    const run = await runCli([
      "notification-template",
      "list",
      "--organization",
      "1",
      "--search",
      "ops",
    ], {
      script: ["notification-template-list"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "notification_templates/",
      query: { organization: 1, search: "ops", page_size: 100 },
    });
  });

  it("rejects a non-positive --organization before any read", async () => {
    const run = await runCli(["notification-template", "list", "--organization", "0"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("--organization");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("rejects a non-positive --limit before any read", async () => {
    const run = await runCli(["notification-template", "list", "--limit", "0"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.transport.requests).toHaveLength(0);
  });
});

describe("notification-template show", () => {
  it("resolves by name and reads template detail", async () => {
    const run = await runCli(["notification-template", "show", "email-ops"], {
      script: ["notification-template-name-one", "notification-template-show"],
    });

    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "notification_templates/",
      query: { name: "email-ops" },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "notification_templates/11/",
    });
    expect(run.stdout).toContain('"notification-template":');
    expect(run.stdout).toContain("name: email-ops");
    expect(run.stdout).toContain("notification_type: email");
  });

  it("redacts secret-bearing config and encrypted values", async () => {
    const run = await runCli(["notification-template", "show", "email-ops"], {
      script: ["notification-template-name-one", "notification-template-show"],
    });

    expect(run.stdout).not.toContain("token123");
    expect(run.stdout).not.toContain("supersecret");
    expect(run.stdout).toContain("$encrypted$");
  });

  it("states no match when name is missing", async () => {
    const run = await runCli(["notification-template", "show", "no such template"], {
      script: ["notification-template-name-none", "notification-template-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.transport.requests).toHaveLength(2);
  });

  it("resolves ambiguous names without reading detail", async () => {
    const run = await runCli(["notification-template", "show", "email-ops"], {
      script: ["notification-template-name-ambiguous"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(run.transport.requests).toHaveLength(1);
  });
});
