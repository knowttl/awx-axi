import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("group domain", () => {
  it("lists groups with AWX search, name, inventory, and row-limit filters", async () => {
    const run = await runCli(
      [
        "group",
        "list",
        "--search",
        "web",
        "--name",
        "web",
        "--inventory",
        "11",
        "--limit",
        "1",
      ],
      { script: ["group-list"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "groups/",
      query: {
        search: "web",
        name: "web",
        inventory: 11,
        page_size: 1,
      },
    });
    expect(run.stdout).toContain("count: 1 of 2 total");
    expect(run.stdout).toContain("Datacenter inventory");
    expect(run.stdout).toContain("groups");
  });

  it("reports an empty filtered result with next-step help", async () => {
    const run = await runCli(
      ["group", "list", "--name", "missing"],
      { script: ["group-list-empty"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("groups: 0 groups found");
    expect(run.stdout).toContain("group show <id|name>");
  });

  it("shows direct hosts, direct children, and parsed recursively redacted variables", async () => {
    const run = await runCli(["group", "show", "31"], {
      script: [
        "group-detail",
        "group-hosts",
        "group-children",
        "group-variable-data",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "groups/31/",
      "groups/31/hosts/",
      "groups/31/children/",
      "groups/31/variable_data/",
    ]);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
    expect(run.stdout).toContain("group:");
    expect(run.stdout).toContain("name: web");
    expect(run.stdout).toContain("inventory: 11 (Datacenter inventory)");
    expect(run.stdout).toContain("web-01.example.com");
    expect(run.stdout).toContain("web-canary");
    expect(run.stdout).toContain("total_hosts: 1");
    expect(run.stdout).toContain("total_children: 1");
    expect(run.stdout).toContain("password: ***");
    expect(run.stdout).toContain("api_key: ***");
    expect(run.stdout).not.toContain("do-not-print");
    expect(run.stdout).not.toContain("also-do-not-print");
  });

  it("resolves a name and tries case-insensitive matching before reporting no match", async () => {
    const run = await runCli(["group", "show", "WEB"], {
      script: [
        "group-name-none",
        "group-name-one",
        "group-detail",
        "group-hosts",
        "group-children",
        "group-variable-data",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      route: "groups/",
      query: { name: "WEB" },
    });
    expect(run.transport.requests[1]).toMatchObject({
      route: "groups/",
      query: { name__iexact: "WEB" },
    });
    expect(run.transport.requests[2]?.route).toBe("groups/31/");
  });

  it("refuses duplicate names across inventories instead of choosing one", async () => {
    const run = await runCli(["group", "show", "web"], {
      script: ["group-name-ambiguous"],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(run.stdout).toContain("2 groups are named");
    expect(run.stdout).toContain("Production inventory");
    expect(run.stdout).toContain("Staging inventory");
    expect(run.stdout).toContain("awx-axi group show 31");
    expect(run.transport.requests[0]?.query).toEqual({ name: "web" });
  });

  it("reports a missing name and does not expose a numeric detail error as a raw response", async () => {
    const missing = await runCli(["group", "show", "missing"], {
      script: ["group-name-none", "group-name-none"],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: NAME_NOT_FOUND");
    expect(missing.stdout).toContain('no group is named \\"missing\\"');

    const notFound = await runCli(["group", "show", "31"], {
      script: [{ status: 404, body: { detail: "Not found." } }],
    });
    expect(notFound.exitCode).toBe(1);
    expect(notFound.stdout).toContain("code: NOT_FOUND");
    expect(notFound.stdout).not.toContain("groups/31/");
    expect(notFound.transport.requests).toHaveLength(1);
  });

  it("is available in read-only mode and documents both help levels", async () => {
    const run = await runCli(["group", "show", "31"], {
      script: [
        "group-detail",
        "group-hosts",
        "group-children",
        "group-variable-data",
      ],
      env: { AWX_AXI_READ_ONLY: "1" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);

    const commandHelp = await runCli(["group", "list", "--help"], { script: [] });
    expect(commandHelp.exitCode).toBe(0);
    expect(commandHelp.stdout).toContain("--inventory <i>");
    expect(commandHelp.stdout).toContain("--limit <n>");

    const nounHelp = await runCli(["group", "--help"], { script: [] });
    expect(nounHelp.exitCode).toBe(0);
    expect(nounHelp.stdout).toContain("direct hosts and child groups");
  });
});
