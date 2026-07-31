import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("inventory domain (design.md §7.1)", () => {
  it("inventory list returns paged rows and preserves totals for search", async () => {
    const run = await runCli(["inventory", "list", "--search", "site", "--limit", "1"], {
      script: ["inventory-list-page-1", "inventory-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/",
      query: { search: "site", page_size: 1 },
    });
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
      script: ["inventory-name-none", "inventory-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('no inventory is named \\"missing\\"');
    expect(run.stdout).toContain('awx-axi inventory list --search \\"missing\\"');
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
    expect(run.stdout).toContain("2 keys");
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

  it("inventory updates follows source pagination to find later matches", async () => {
    const firstPageSources = {
      status: 200,
      body: {
        count: 101,
        next: "/api/v2/inventories/11/inventory_sources/?page=2&page_size=100",
        previous: null,
        results: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `source-${index + 1}`,
          source: "ec2",
          status: "successful",
        })),
      },
    };

    const secondPageSource = {
      status: 200,
      body: {
        count: 101,
        next: null,
        previous: "/api/v2/inventories/11/inventory_sources/?page=1&page_size=100",
        results: [
          {
            id: 201,
            name: "late source",
            source: "manual",
            status: "successful",
          },
        ],
      },
    };

    const emptySourceUpdates = {
      status: 200,
      body: {
        count: 0,
        next: null,
        previous: null,
        results: [],
      },
    };

    const lateUpdate = {
      status: 200,
      body: {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 901,
            name: "late sync",
            status: "successful",
            finished: "2026-07-29T10:30:00Z",
            created: "2026-07-29T10:00:00Z",
          },
        ],
      },
    };

    const run = await runCli(["inventory", "updates", "11"], {
      script: [
        firstPageSources,
        ...Array.from({ length: 100 }, () => emptySourceUpdates),
        secondPageSource,
        lateUpdate,
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "inventories/11/inventory_sources/",
      query: { page_size: 100 },
    });
    expect(run.transport.requests[101]).toMatchObject({
      method: "GET",
      route: "inventories/11/inventory_sources/",
      query: { page: "2", page_size: "100" },
    });
    expect(run.stdout).toContain("late sync");
    expect(run.stdout).toContain("201 (late source)");
  });

  it("inventory updates validates status input", async () => {
    const run = await runCli(["inventory", "updates", "11", "--status", "invalid"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain('unknown --status \\"invalid\\" for `inventory updates`');
  });

  it("constructed list stays usable when unsupported", async () => {
    const run = await runCli(["inventory", "constructed-list"], {
      script: ["inventory-constructed-list-404"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("0 constructed inventories found");
    expect(run.stdout).toContain("This controller does not expose constructed inventories");
  });

  it("inventory constructed-show resolves by name and renders key fields", async () => {
    const run = await runCli(["inventory", "constructed-show", "Datacenter constructed"], {
      script: ["inventory-constructed-name-one", "inventory-constructed-detail"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "constructed_inventories/",
      query: { name: "Datacenter constructed" },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "constructed_inventories/301/",
    });
    expect(run.stdout).toContain("id: 301");
    expect(run.stdout).toContain("name: Datacenter constructed");
    expect(run.stdout).toContain("source: ec2");
    expect(run.stdout).toContain("verbosity: 2");
    expect(run.stdout).toContain("limit: 500");
    expect(run.stdout).toContain("update_cache_timeout: 3600");
    expect(run.stdout).toContain("Run `awx-axi inventory constructed-list` to inspect all constructed inventories");
  });

  it("inventory sync defaults to dry run without --confirm", async () => {
    const run = await runCli(["inventory", "sync", "21"], {
      script: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("would_send: POST inventory_sources/21/update/");
    expect(run.stdout).toContain("help[1]: Re-run with --confirm to sync");
  });

  it("inventory sync executes live with --confirm", async () => {
    const run = await runCli(["inventory", "sync", "21", "--confirm"], {
      script: [{ status: 202, body: { id: 301, status: "pending" } }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 301");
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "inventory_sources/21/update/",
    });
  });

  it("inventory create and edit work with dry-run and --confirm", async () => {
    const dry = await runCli(["inventory", "create", "Production"], { script: [] });
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry_run:");
    expect(dry.stdout).toContain("would_send: POST inventories/");

    const live = await runCli(["inventory", "create", "Production", "--confirm"], {
      script: [{ status: 201, body: { id: 50, name: "Production" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(live.exitCode).toBe(0);
    expect(live.stdout).toContain("id: 50");

    const editDry = await runCli(["inventory", "edit", "50", "--name", "Prod-Updated"], { script: [] });
    expect(editDry.exitCode).toBe(0);
    expect(editDry.stdout).toContain("would_send: PATCH inventories/50/");

    const editLive = await runCli(["inventory", "edit", "50", "--name", "Prod-Updated", "--confirm"], {
      script: [{ status: 200, body: { id: 50, name: "Prod-Updated" } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(editLive.exitCode).toBe(0);
    expect(editLive.stdout).toContain("name: Prod-Updated");
  });

  it("host create and edit work with dry-run and --confirm", async () => {
    const dry = await runCli(["inventory", "host", "create", "web-01", "--inventory", "50"], { script: [] });
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry_run:");
    expect(dry.stdout).toContain("would_send: POST hosts/");

    const live = await runCli(["inventory", "host-create", "web-01", "--inventory", "50", "--confirm"], {
      script: [{ status: 201, body: { id: 101, name: "web-01", enabled: true } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(live.exitCode).toBe(0);
    expect(live.stdout).toContain("id: 101");

    const editDry = await runCli(["inventory", "host", "edit", "101", "--disabled"], { script: [] });
    expect(editDry.exitCode).toBe(0);
    expect(editDry.stdout).toContain("would_send: PATCH hosts/101/");

    const editLive = await runCli(["inventory", "host-edit", "101", "--disabled", "--confirm"], {
      script: [{ status: 200, body: { id: 101, name: "web-01", enabled: false } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(editLive.exitCode).toBe(0);
    expect(editLive.stdout).toContain("enabled: false");
  });
});
