import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("host domain", () => {
  it("lists hosts with real AWX filters and inventory context", async () => {
    const run = await runCli(
      [
        "host",
        "list",
        "--search",
        "web",
        "--name",
        "web-01.example.com",
        "--inventory",
        "11",
        "--limit",
        "1",
      ],
      { script: ["host-list"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "hosts/",
      query: {
        search: "web",
        name: "web-01.example.com",
        inventory: 11,
        page_size: 1,
      },
    });
    expect(run.stdout).toContain("count: 1 of 2 total");
    expect(run.stdout).toContain("web-01.example.com");
    expect(run.stdout).toContain("11 (Datacenter inventory)");
    expect(run.stdout).toContain(',"1",true');
  });

  it("reports a deterministic empty state", async () => {
    const run = await runCli(
      ["host", "list", "--name", "missing"],
      { script: ["host-list-empty"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("hosts: 0 hosts found");
    expect(run.stdout).toContain("host show <id|name>");
  });

  it("shows an id-resolved host with groups, variables, facts, and context", async () => {
    const run = await runCli(["host", "show", "501"], {
      script: [
        "host-detail",
        "host-groups",
        "host-variable-data",
        "host-ansible-facts",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(4);
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "hosts/501/",
      "hosts/501/groups/",
      "hosts/501/variable_data/",
      "hosts/501/ansible_facts/",
    ]);
    expect(run.stdout).toContain("host:");
    expect(run.stdout).toContain("name: web-01.example.com");
    expect(run.stdout).toContain("inventory: 11 (Datacenter inventory)");
    expect(run.stdout).toContain('organization: "1"');
    expect(run.stdout).toContain("groups");
    expect(run.stdout).toContain("web");
    expect(run.stdout).toContain("ansible_host: 10.0.0.11");
    expect(run.stdout).toContain("ansible_distribution: Debian");
    expect(run.stdout).toContain("Run `awx-axi host list --inventory 11`");
  });

  it("resolves a bare host name across inventories without an inventory lookup", async () => {
    const run = await runCli(["host", "show", "web-01.example.com"], {
      script: [
        "host-name-one",
        "host-detail",
        "host-groups",
        "host-variable-data",
        "host-ansible-facts",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "hosts/",
      query: { name: "web-01.example.com" },
    });
    expect(run.transport.requests[1]?.route).toBe("hosts/501/");
    expect(run.transport.requests.every((request) => request.route !== "inventories/")).toBe(true);
  });

  it("tries case-insensitive name matching before reporting no match", async () => {
    const run = await runCli(["host", "show", "WEB-01.EXAMPLE.COM"], {
      script: [
        "host-name-none",
        "host-name-one",
        "host-detail",
        "host-groups",
        "host-variable-data",
        "host-ansible-facts",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toEqual({
      name: "WEB-01.EXAMPLE.COM",
    });
    expect(run.transport.requests[1]?.query).toEqual({
      name__iexact: "WEB-01.EXAMPLE.COM",
    });
  });

  it("reports zero name matches as NAME_NOT_FOUND", async () => {
    const run = await runCli(["host", "show", "missing"], {
      script: ["host-name-none", "host-name-none"],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.stdout).toContain('no host is named \\"missing\\"');
    expect(run.stdout).toContain('awx-axi host list --search \\"missing\\"');
  });

  it("refuses an ambiguous bare name and identifies each inventory scope", async () => {
    const run = await runCli(["host", "show", "web-01.example.com"], {
      script: ["host-name-ambiguous"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(run.stdout).toContain("2 hosts are named");
    expect(run.stdout).toContain("501");
    expect(run.stdout).toContain("Production inventory");
    expect(run.stdout).toContain("601");
    expect(run.stdout).toContain("Staging inventory");
    expect(run.stdout).toContain("awx-axi host show 501");
  });

  it("redacts sensitive variables and facts", async () => {
    const run = await runCli(["host", "show", "501"], {
      script: [
        "host-detail",
        "host-groups",
        "host-variable-data",
        "host-ansible-facts",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("do-not-print");
    expect(run.stdout).toContain("password: ***");
    expect(run.stdout).toContain("api_key: ***");
  });

  it("translates a host detail error without issuing relationships", async () => {
    const run = await runCli(["host", "show", "501"], {
      script: [{ status: 404, body: { detail: "Not found." } }],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NOT_FOUND");
    expect(run.stdout).toContain("host 501");
    expect(run.transport.requests).toHaveLength(1);
  });

  it("is available in read-only mode and issues only GET requests", async () => {
    const run = await runCli(["host", "show", "501"], {
      script: [
        "host-detail",
        "host-groups",
        "host-variable-data",
        "host-ansible-facts",
      ],
      env: { AWX_AXI_READ_ONLY: "1" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("documents host commands in contextual help", async () => {
    const help = await runCli(["host", "list", "--help"], { script: [] });

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("awx-axi host list [--search <s>] [--name <n>] [--inventory <i>] [--limit <n>]");

    const noun = await runCli(["host", "--help"], { script: [] });
    expect(noun.exitCode).toBe(0);
    expect(noun.stdout).toContain("inspect managed hosts across all visible inventories");
  });
});
