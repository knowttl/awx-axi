import { describe, expect, it } from "vitest";
import { MAX_LIMIT, MAX_PAGES, MAX_ROWS } from "../src/core/paginate.js";
import { RecordedTransport } from "../src/core/transport.js";
import { runCli } from "./support/run.js";

function page(ids: number[], next: string | null = null, count = 3) {
  return { status: 200, body: { count, next, results: ids.map((id) => ({ id, name: `item ${id}` })) } };
}

describe("collection budgets through the CLI", () => {
  it.each([
    ["job", "list"], ["job", "events", "1"], ["job", "hosts", "1"],
    ["approval", "list"], ["workflow", "list"], ["workflow", "nodes", "1"],
    ["workflow", "template-nodes", "1"], ["workflow", "object-roles", "1"],
  ])("%j honors all and max-rows and discloses the server total", async (...command) => {
    const run = await runCli([...command, "--all", "--max-rows", "2"], {
      script: [page([1], "/api/v2/items/?page=2"), page([2], "/api/v2/items/?page=3")],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.stdout).toContain("count: 2 of 3 total");
    expect(run.stdout).toContain("stop: row-budget");
    expect(run.stdout).toContain("truncated: true");
    expect(run.stdout).toContain("next: /api/v2/items/?page=3");
  });

  it.each([
    ["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "NaN"],
    ["--limit", ""], ["--limit", "1e2"], ["--limit", String(MAX_LIMIT + 1)],
    ["--all", "--limit", "2"], ["--max-rows", "2"],
    ["--all", "--max-rows", "0"], ["--all", "--max-rows", "1.5"],
    ["--all", "--max-rows", String(MAX_ROWS + 1)],
  ])("rejects %j before a request", async (...flags) => {
    const run = await runCli(["job", "list", ...flags]);
    expect(run.exitCode).toBe(2);
    expect(run.transport.requests).toHaveLength(0);
  });

  it("all preserves approval pending filtering independently of include-decided", async () => {
    const run = await runCli(["approval", "list", "--all"], { script: [page([])] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query.status).toBe("pending");
  });

  it("include-decided works with all without a pending filter", async () => {
    const run = await runCli(["approval", "list", "--include-decided", "--all"], { script: [page([])] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query.status).toBeUndefined();
  });

  it("does not label an empty incomplete collection as an empty inbox", async () => {
    const run = await runCli(["approval", "list", "--all"], { script: [page([], "/api/v2/items/?page=2", 7)] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("count: 0 of 7 total");
    expect(run.stdout).toContain("collection is incomplete");
    expect(run.stdout).toContain("stop: empty-page");
    expect(run.stdout).not.toContain("0 approvals pending");
  });
});

describe("shared transport pagination seam", () => {
  it("accepts the limit ceiling and preserves the total on an empty collection", async () => {
    const transport = new RecordedTransport([page([], null, 0)]);
    const result = await transport.getPaged("items/", {}, MAX_LIMIT);
    expect(result.count).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.pagination).toMatchObject({ stop: "complete", truncated: false, next: null });
  });

  it.each([0, -1, 1.5, Infinity, MAX_LIMIT + 1])("rejects invalid transport limit %s before reading", async (limit) => {
    const transport = new RecordedTransport([]);
    await expect(transport.getPaged("items/", {}, limit)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transport.requests).toHaveLength(0);
  });

  it("does not claim truncation when the final page exactly fills the cap", async () => {
    const transport = new RecordedTransport([page([1], "items/?page=2"), page([2], null, 2)]);
    const result = await transport.getPaged("items/", {}, { all: true, maxRows: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.pagination).toMatchObject({ stop: "complete", truncated: false, pages: 2 });
    expect(result.count).toBe(3);
  });

  it("discloses a partial final page without treating next as a lossless cursor", async () => {
    const transport = new RecordedTransport([page([1, 2, 3], null)]);
    const result = await transport.getPaged("items/", {}, 2);
    expect(result.rows).toEqual([{ id: 1, name: "item 1" }, { id: 2, name: "item 2" }]);
    expect(result.pagination).toMatchObject({ stop: "row-budget", truncated: true, partial_page: true, next: null });
  });

  it("stops repeated next pages before reading the same continuation again", async () => {
    const transport = new RecordedTransport([page([1], "items/?page=2"), page([2], "items/?page=2")]);
    const result = await transport.getPaged("items/", {}, { all: true, maxRows: MAX_ROWS });
    expect(transport.requests).toHaveLength(2);
    expect(result.pagination).toMatchObject({ stop: "repeated-page", truncated: true, next: "items/?page=2" });
  });

  it("bounds page reads even when each page makes only one row of progress", async () => {
    const transport = new RecordedTransport(Array.from({ length: MAX_PAGES }, (_, i) => page([i], `items/?page=${i + 2}`, 999)));
    const result = await transport.getPaged("items/", {}, { all: true, maxRows: MAX_ROWS });
    expect(transport.requests).toHaveLength(MAX_PAGES);
    expect(result.rows).toHaveLength(MAX_PAGES);
    expect(result.count).toBe(999);
    expect(result.pagination).toMatchObject({ stop: "page-budget", truncated: true, pages: MAX_PAGES });
  });
});
