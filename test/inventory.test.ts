import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("inventory domain (design.md §7.1)", () => {
  it("inventory list returns paged rows and preserves totals for search", async () => {
    const run = await runCli(["inventory", "list", "--search", "site", "--limit", "1"], {
      script: ["inventory-list-page-1", "inventory-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/",
      query: { search: "site", page_size: 1 },
    });
    expect(run.transport.requests[1].route).toBe("/api/v2/inventories/");
    expect(run.stdout).toContain("count: 1 of 2 total");
    expect(run.stdout).toContain("inventories");
    expect(run.stdout).toContain("Datacenter inventory");
  });

  it("inventory show resolves by name and returns detail", async () => {
    const run = await runCli(["inventory", "show", "Datacenter inventory"], {
      script: ["inventory-name-one", "inventory-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/",
      query: { name: "Datacenter inventory" },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "inventories/11/",
    });
    expect(run.stdout).toContain("id: 11");
    expect(run.stdout).toContain("Datacenter inventory");
    expect(run.stdout).toContain("total_hosts: 2");
    expect(run.stdout).toContain("Run `awx-axi inventory groups 11`");
  });

  it("inventory show reports a missing name with guidance", async () => {
    const run = await runCli(["inventory", "show", "missing"], {
      script: ["inventory-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("no inventory is named \"missing\"");
    expect(run.stdout).toContain("awx-axi inventory list --search \"missing\"");
  });

  it("inventory hosts can request ansible fact key counts", async () => {
    const run = await runCli(["inventory", "hosts", "11", "--facts"], {
      script: ["inventory-hosts", "inventory-host-facts"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/11/hosts/",
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "hosts/501/ansible_facts/",
    });
    expect(run.stdout).toContain("facts: 2 keys");
    expect(run.stdout).toContain("hosts");
  });

  it("inventory groups filters and supports limit", async () => {
    const run = await runCli(["inventory", "groups", "11", "--search", "web", "--limit", "1"], {
      script: ["inventory-groups"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/11/groups/",
      query: { search: "web", page_size: 1 },
    });
    expect(run.stdout).toContain("groups");
    expect(run.stdout).toContain("web hosts");
  });

  it("inventory sources support filtering and follow-up help", async () => {
    const run = await runCli(["inventory", "sources", "11", "--search", "aws"], {
      script: ["inventory-sources"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/11/inventory_sources/",
      query: { search: "aws", page_size: 100 },
    });
    expect(run.stdout).toContain("inventory_sources");
    expect(run.stdout).toContain("Run `awx-axi inventory updates 11`");
  });

  it("inventory updates can filter by status", async () => {
    const run = await runCli([
      "inventory",
      "updates",
      "11",
      "--status",
      "successful",
      "--search",
      "nightly",
    ], {
      script: ["inventory-sources", "inventory-source-updates"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "inventory_sources/21/inventory_updates/",
      query: { search: "nightly", status: "successful", page_size: 25 },
    });
    expect(run.stdout).toContain("inventory_updates");
    expect(run.stdout).toContain("initial sync");
  });

  it("inventory updates validates status input", async () => {
    const run = await runCli(["inventory", "updates", "11", "--status", "invalid"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain('unknown --status "invalid" for `inventory updates`');
  });

  it("constructed list stays usable when unsupported", async () => {
    const run = await runCli(["inventory", "constructed-list"], {
      script: ["inventory-constructed-list-404"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("0 constructed inventories found");
    expect(run.stdout).toContain("This controller does not expose constructed inventories");
  });
});
