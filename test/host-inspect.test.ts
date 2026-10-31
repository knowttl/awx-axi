import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { createServer } from "node:http";

import { runCli } from "./support/run.js";
import { fixtureFetch, loadFixture } from "./support/fixtures.js";
import { main } from "../src/cli.js";
import { HttpTransport } from "../src/core/transport.js";

const detail = ["host-detail", "host-groups", "host-variable-data", "host-ansible-facts"];
const page = (next: string | null) => ({ status: 200, body: { count: 200, next, previous: null, results: [{ id: 31, name: "web", inventory: 11 }] } });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("host inspect CLI", () => {
  it("inspects selected IDs and scoped names with full redacted components using only GETs", async () => {
    const run = await runCli(["host", "inspect", "501,web-01.example.com", "--inventory", "11"], {
      script: [...detail, "host-name-one", ...detail], env: { AWX_AXI_READ_ONLY: "1" },
    });
    expect(run.exitCode).toBe(0);
    expect(decode(run.stdout)).toMatchObject({ complete: true, hosts: [
      { selector: "501", status: "complete", variables: { ansible_host: "10.0.0.11" }, facts: { ansible_distribution: "Debian" } },
      { selector: "web-01.example.com", status: "complete", host: { inventory: "11 (Datacenter inventory)" } },
    ] });
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
    expect(run.transport.requests[4]).toMatchObject({ query: { name: "web-01.example.com", inventory: 11 } });
    expect(run.stdout).not.toContain("do-not-print");
  });

  it("reports ambiguous candidates with inventory context and continues other selections", async () => {
    const run = await runCli(["host", "inspect", "web-01.example.com,501"], { script: ["host-name-ambiguous", ...detail] });
    expect(run.exitCode).toBe(1);
    expect(decode(run.stdout)).toMatchObject({ complete: false, hosts: [
      { status: "failed", error: { code: "AMBIGUOUS_NAME", candidates: [
        { id: 501, inventory: "11 (Production inventory)" }, { id: 601, inventory: "21 (Staging inventory)" },
      ] } },
      { status: "complete" },
    ] });
  });

  it("refuses numeric IDs outside the selected inventory before reading relationships", async () => {
    const run = await runCli(["host", "inspect", "501", "--inventory", "12"], { script: ["host-detail"] });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("INVENTORY_MISMATCH");
    expect(run.transport.requests.map((request) => request.route)).toEqual(["hosts/501/"]);
  });

  it("preserves successful components and hosts when a component is forbidden", async () => {
    const run = await runCli(["host", "inspect", "501,502"], { script: [
      "host-detail", "host-groups", { status: 403, body: { detail: "Permission denied." } }, "host-ansible-facts", ...detail,
    ] });
    expect(run.exitCode).toBe(1);
    expect(decode(run.stdout)).toMatchObject({ complete: false, hosts: [
      { status: "failed", groups: [{ name: "web" }, { name: "production" }], facts: { ansible_distribution: "Debian" }, errors: [{ component: "variables", code: "FORBIDDEN" }] },
      { status: "complete" },
    ] });
  });

  it("stops at 100 GETs including group pages and marks remaining selections skipped", async () => {
    const run = await runCli(["host", "inspect", "501,502"], { script: [
      "host-detail", ...Array.from({ length: 99 }, (_, i) => page(`/api/v2/hosts/501/groups/?page=${i + 2}`)),
    ] });
    expect(run.exitCode).toBe(1);
    expect(run.transport.requests).toHaveLength(100);
    expect(decode(run.stdout)).toMatchObject({ complete: false, budgets: { requests: 100 }, hosts: [
      { status: "failed", host: { id: 501 }, errors: [{ component: "groups", code: "REQUEST_BUDGET" }], skipped_components: ["variables", "facts"] },
      { status: "skipped", error: { code: "REQUEST_BUDGET" } },
    ] });
  });

  it("counts retry attempts within the shared CLI request budget", async () => {
    const busy = { status: 503, body: { detail: "Temporarily unavailable" } };
    const fixture = fixtureFetch(["host-detail", ...Array.from({ length: 33 }, (_, i) => [busy, busy, page(`/api/v2/hosts/501/groups/?page=${i + 2}`)]).flat()]);
    let stdout = "";
    const previous = process.exitCode;
    try {
      await main({ argv: ["host", "inspect", "501,502"], env: {}, stdout: { write: (chunk) => { stdout += chunk; } },
        createTransport: () => new HttpTransport({ baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: true, fetch: fixture.fetch, sleep: () => Promise.resolve() }),
      });
      expect(process.exitCode).toBe(1);
      expect(fixture.calls).toHaveLength(100);
      expect(decode(stdout)).toMatchObject({ budgets: { requests: 100 }, hosts: [{ status: "failed", errors: [{ code: "REQUEST_BUDGET" }] }, { status: "skipped" }] });
    } finally {
      process.exitCode = previous;
    }
  });

  it("discloses stalled group pagination while retaining variables and facts", async () => {
    const run = await runCli(["host", "inspect", "501"], { script: [
      "host-detail", page("/api/v2/hosts/501/groups/?page=2"), page("/api/v2/hosts/501/groups/?page=2"), "host-variable-data", "host-ansible-facts",
    ] });
    expect(run.exitCode).toBe(1);
    expect(decode(run.stdout)).toMatchObject({ hosts: [{ status: "failed", groups_pagination: { truncated: true, stop: "repeated-page" }, variables: { ansible_host: "10.0.0.11" }, facts: { ansible_distribution: "Debian" } }] });
  });

  it("stops further reads when the total time budget expires", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000);
    const run = await runCli(["host", "inspect", "501,502"], { script: [] });
    expect(run.exitCode).toBe(1);
    expect(run.transport.requests).toHaveLength(0);
    expect(decode(run.stdout)).toMatchObject({ hosts: [{ status: "failed", error: { code: "TIME_BUDGET" } }, { status: "skipped" }] });
  });

  it.each([false, true])("cancels an in-flight group read at the total deadline (partial body: %s)", async (partialBody) => {
    let started!: () => void;
    const stalled = new Promise<void>((resolve) => { started = resolve; });
    const server = createServer((request, response) => {
      if (request.url === "/api/v2/hosts/501/") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(loadFixture("host-detail").body));
      } else {
        if (partialBody) { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"results":['); }
        started();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const previous = process.exitCode;
    let stdout = "";
    try {
      const address = server.address() as { port: number };
      const running = main({ argv: ["host", "inspect", "501,502"], env: {}, stdout: { write: (chunk) => { stdout += chunk; } },
        createTransport: () => new HttpTransport({ baseUrl: `http://127.0.0.1:${address.port}`, apiBasePath: "/api/v2/", readOnly: true }),
      });
      await stalled;
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
      expect(process.exitCode).toBe(1);
      expect(decode(stdout)).toMatchObject({ complete: false, hosts: [
        { status: "failed", host: { id: 501 }, errors: [{ component: "groups", code: "TIME_BUDGET" }] },
        { status: "skipped", error: { code: "TIME_BUDGET" } },
      ] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.exitCode = previous;
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([1, 10])("caps rendered output for %s hosts with labeled redacted previews and recovery hints", async (count) => {
    const selectors = Array.from({ length: count }, () => "501").join(",");
    const run = await runCli(["host", "inspect", selectors], { script: Array.from({ length: count }, () => [
      "host-detail", "host-groups", { status: 200, body: { password: "do-not-print", notes: '"\n'.repeat(5_000) } }, { status: 200, body: { facts: "x".repeat(20_000) } },
    ]).flat() });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.length).toBeLessThanOrEqual(20_000);
    expect(decode(run.stdout)).toMatchObject({ complete: false, hosts: Array.from({ length: count }, () => ({ status: "failed", code: "OUTPUT_BUDGET", variables: { truncated: true }, facts: { truncated: true }, help: "Run `awx-axi host show 501` for full details" })) });
    expect(run.stdout).not.toContain("do-not-print");
  });

  it.each(["", "501,", "0", Array.from({ length: 11 }, (_, i) => String(i + 1)).join(",")])("rejects invalid selection %s before reads", async (selection) => {
    const run = await runCli(["host", "inspect", selection]);
    expect(run.exitCode).toBe(2);
    expect(run.transport.requests).toHaveLength(0);
  });
});
