import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { DOMAINS } from "../src/cli.js";
import { runCli } from "./support/run.js";

const directory = {
  "activity-stream": ["list"],
  credential: ["list", "object-roles"],
  group: ["list"],
  host: ["list"],
  inventory: ["list", "groups", "hosts", "sources", "constructed-list"],
  notification: ["list"],
  "notification-template": ["list"],
  organization: ["list"],
  role: ["list", "parents", "children", "users", "teams"],
  team: ["list", "users", "projects", "credentials", "roles", "object-roles", "access-list"],
  user: ["list"],
};
const consumers = Object.entries(directory).flatMap(([domain, commands]) =>
  commands.map((command) => ({ domain, command, argv: [domain, command, ...(["list", "constructed-list"].includes(command) ? [] : ["1"])] })),
);
const page = (ids: number[], next: string | null, count = 3) => ({
  status: 200, body: { count, next, results: ids.map((id) => ({ id, name: `item ${id}` })) },
});

describe("directory collection pagination", () => {
  it("partitions every registered domain list into the foundation, automation, or directory batch", () => {
    const foundation = ["job", "approval", "workflow"];
    const automation = ["ad-hoc", "execution-environment", "inventory-source", "project", "schedule", "system-job", "system-job-template", "template"];
    expect(DOMAINS.filter((domain) => domain.subcommands.some((command) => command.name === "list")).map((domain) => domain.name).sort())
      .toEqual([...foundation, ...automation, ...Object.keys(directory)].sort());
  });

  it("covers every directory collection schema except the updates aggregate", () => {
    const registered = DOMAINS.filter((domain) => Object.keys(directory).includes(domain.name))
      .flatMap((domain) => domain.subcommands.filter((command) => command.schema.defaultFields.length > 0 && !(domain.name === "inventory" && command.name === "updates"))
        .map((command) => `${domain.name} ${command.name}`));
    expect(registered.sort()).toEqual(consumers.map(({ domain, command }) => `${domain} ${command}`).sort());
  });

  it.each(consumers)("$domain $command advertises and executes bounded page walking", async ({ argv }) => {
    const run = await runCli([...argv, "--all", "--max-rows", "2"], {
      script: [page([1], "/api/v2/items/?page=2"), page([2, 3], null)],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(decode(run.stdout)).toMatchObject({ count: "2 of 3 total", pagination: {
      max_rows: 2, pages: 2, truncated: true, stop: "row-budget", partial_page: true,
    } });
    const help = await runCli([...argv, "--help"]);
    expect(help.stdout).toContain("--all");
    expect(help.stdout).toContain("--max-rows");
    expect(help.transport.requests).toHaveLength(0);
  });

  it.each(consumers)("$domain $command preserves the 100 row default", async ({ argv }) => {
    const run = await runCli(argv, { script: [page([1], null)] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query.page_size).toBe(100);
    expect(decode(run.stdout)).toMatchObject({ pagination: { max_rows: 100, stop: "complete" } });
  });

  it.each(consumers)("$domain $command uses the shared all default beyond 100 rows", async ({ argv }) => {
    const run = await runCli([...argv, "--all"], {
      script: [page(Array.from({ length: 100 }, (_, index) => index + 1), "/api/v2/items/?page=2", 101), page([101], null, 101)],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query.page_size).toBe(200);
    expect(decode(run.stdout)).toMatchObject({ count: "101 total", pagination: { max_rows: 10000, pages: 2, stop: "complete" } });
  });

  it.each(consumers)("$domain $command finishes at an exact limit across pages", async ({ argv }) => {
    const run = await runCli([...argv, "--limit", "3"], {
      script: [page([1], "/api/v2/items/?page=2"), page([2, 3], null)],
    });
    expect(run.exitCode).toBe(0);
    expect(decode(run.stdout)).toMatchObject({ count: "3 total", pagination: { truncated: false, stop: "complete", pages: 2 } });
  });

  const invalid = [["--limit", "1001"], ["--all", "--limit", "2"], ["--max-rows", "2"], ["--all", "--max-rows", "10001"], ["--al"]];
  it.each(consumers.flatMap((consumer) => invalid.map((flags) => ({ ...consumer, flags }))))(
    "$domain $command rejects $flags before reading", async ({ argv, flags }) => {
      const namedArgv = argv.map((arg) => arg === "1" ? "example" : arg);
      const run = await runCli([...namedArgv, ...flags]);
      expect(run.exitCode).toBe(2);
      expect(run.transport.requests).toHaveLength(0);
    },
  );
});
