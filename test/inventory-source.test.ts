import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("inventory-source domain", () => {
  it("lists sources with practical AWX filters and a row limit", async () => {
    const run = await runCli(
      [
        "inventory-source",
        "list",
        "--search",
        "sync",
        "--name",
        "Nightly EC2 sync",
        "--inventory",
        "11",
        "--source",
        "ec2",
        "--status",
        "successful",
        "--limit",
        "1",
      ],
      { script: ["inventory-source-list"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventory_sources/",
      query: {
        search: "sync",
        name: "Nightly EC2 sync",
        inventory: 11,
        source: "ec2",
        status: "successful",
        page_size: 1,
      },
    });
    expect(run.stdout).toContain("count: 1 of 2 total");
    expect(run.stdout).toContain("Nightly EC2 sync");
    expect(run.stdout).toContain("successful");
    expect(run.stdout).toContain("Datacenter inventory");
  });

  it("reports an empty result with source inspection help", async () => {
    const run = await runCli(
      ["inventory-source", "list", "--status", "failed"],
      { script: ["inventory-source-list-empty"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("inventory_sources: 0 inventory sources found");
    expect(run.stdout).toContain("inventory-source show <id|name>");
  });

  it("shows safe source configuration, update state, and direct update history", async () => {
    const run = await runCli(["inventory-source", "show", "21"], {
      script: ["inventory-source-detail", "inventory-source-updates-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "inventory_sources/21/",
      "inventory_sources/21/inventory_updates/",
    ]);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
    expect(run.stdout).toContain("inventory_source:");
    expect(run.stdout).toContain("name: Nightly EC2 sync");
    expect(run.stdout).toContain("inventory: 11 (Datacenter inventory)");
    expect(run.stdout).toContain("organization: 1 (Operations)");
    expect(run.stdout).toContain("source: ec2");
    expect(run.stdout).toContain("source_project: 4 (infra-playbooks)");
    expect(run.stdout).toContain("credential: 7 (AWS cloud)");
    expect(run.stdout).toContain("status: successful");
    expect(run.stdout).toContain("last_update_failed: false");
    expect(run.stdout).toContain("last_update: 901 (initial sync)");
    expect(run.stdout).toContain("total_updates: 2");
    expect(run.stdout).toContain("updates");
    expect(run.stdout).toContain("current sync");
    expect(run.stdout).toContain("password: ***");
    expect(run.stdout).toContain("api_key: ***");
    expect(run.stdout).not.toContain("do-not-print");
    expect(run.stdout).not.toContain("access-do-not-print");
    expect(run.stdout).not.toContain("also-do-not-print");
  });

  it("resolves names case-insensitively and refuses duplicate names across inventories", async () => {
    const resolved = await runCli(["inventory-source", "show", "nightly ec2 sync"], {
      script: [
        "inventory-source-name-none",
        "inventory-source-name-one",
        "inventory-source-detail",
        "inventory-source-updates-detail",
      ],
    });
    expect(resolved.exitCode).toBe(0);
    expect(resolved.transport.requests[0]?.query).toEqual({ name: "nightly ec2 sync" });
    expect(resolved.transport.requests[1]?.query).toEqual({ name__iexact: "nightly ec2 sync" });
    expect(resolved.transport.requests[2]?.route).toBe("inventory_sources/21/");

    const ambiguous = await runCli(["inventory-source", "show", "Nightly sync"], {
      script: ["inventory-source-name-ambiguous"],
    });
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(ambiguous.stdout).toContain("2 inventory sources are named");
    expect(ambiguous.stdout).toContain("Production inventory");
    expect(ambiguous.stdout).toContain("Staging inventory");
    expect(ambiguous.stdout).toContain("awx-axi inventory-source show 21");
  });

  it("reports a missing name and a numeric detail error through stable codes", async () => {
    const missing = await runCli(["inventory-source", "show", "missing"], {
      script: ["inventory-source-name-none", "inventory-source-name-none"],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: NAME_NOT_FOUND");

    const notFound = await runCli(["inventory-source", "show", "21"], {
      script: [{ status: 404, body: { detail: "Not found." } }],
    });
    expect(notFound.exitCode).toBe(1);
    expect(notFound.stdout).toContain("code: NOT_FOUND");
    expect(notFound.transport.requests).toHaveLength(1);
  });

  it("works in read-only mode and exposes focused list and noun help", async () => {
    const run = await runCli(["inventory-source", "show", "21"], {
      script: ["inventory-source-detail", "inventory-source-updates-detail"],
      env: { AWX_AXI_READ_ONLY: "1" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);

    const commandHelp = await runCli(["inventory-source", "list", "--help"], { script: [] });
    expect(commandHelp.exitCode).toBe(0);
    expect(commandHelp.stdout).toContain("--source <type>");
    expect(commandHelp.stdout).toContain("--status <s>");

    const nounHelp = await runCli(["inventory-source", "--help"], { script: [] });
    expect(nounHelp.exitCode).toBe(0);
    expect(nounHelp.stdout).toContain("update history");
  });
});
