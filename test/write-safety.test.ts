import { describe, expect, it } from "vitest";

import { AxiError } from "axi-sdk-js";
import { runPlan, write, type AwxRequest, type RouteDescription } from "../src/core/registry.js";
import {
  assertWritable,
  HttpTransport,
  RecordedTransport,
  type AwxTransport,
  type RecordedRequest,
} from "../src/core/transport.js";
import { runCli } from "./support/run.js";

/**
 * Compile-time write safety and transport assertions.
 */
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type HasAny<T, K extends PropertyKey> = [Extract<keyof T, K>] extends [never]
  ? false
  : true;

// `AwxTransport` exports get, post, put, patch, delete, getPaged, getText.
export type _TransportSurfaceIsClosed = Expect<
  Equal<
    keyof AwxTransport,
    "get" | "post" | "put" | "patch" | "delete" | "getPaged" | "getText"
  >
>;

// A route description carries no HTTP verb.
export type _RouteCarriesNoVerb = Expect<
  Equal<HasAny<RouteDescription, "method" | "verb" | "httpMethod">, false>
>;
export type _RouteSurfaceIsClosed = Expect<Equal<keyof RouteDescription, "path" | "query">>;

// `AwxRequest` supports write requests with HTTP methods and risk tier tags.
export type _RequestKindsAreClosed = Expect<
  Equal<
    AwxRequest["kind"],
    "read" | "readPaged" | "readText" | "write" | "delay"
  >
>;

describe("transport write verb methods", () => {
  it("exposes post, put, patch, delete on AwxTransport surface", () => {
    const surface: Array<keyof AwxTransport> = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "getPaged",
      "getText",
    ];
    expect(surface).toHaveLength(7);
  });

  it("RecordedTransport records post, put, patch, delete requests with tags", async () => {
    const transport = new RecordedTransport(
      [
        { status: 201, body: { id: 1 } },
        { status: 200, body: { id: 1, updated: true } },
        { status: 200, body: { id: 1, patched: true } },
        { status: 204, body: undefined },
      ],
      { env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1" } },
    );

    await transport.post("items/", { name: "item1" }, "operational");
    await transport.put("items/1/", { name: "updated" }, "config");
    await transport.patch("items/1/", { name: "patched" }, "config");
    await transport.delete("items/1/", "delete");

    expect(transport.requests).toHaveLength(4);
    expect(transport.requests[0]).toMatchObject({
      method: "POST",
      route: "items/",
      body: { name: "item1" },
      tag: "operational",
    });
    expect(transport.requests[1]).toMatchObject({
      method: "PUT",
      route: "items/1/",
      body: { name: "updated" },
      tag: "config",
    });
    expect(transport.requests[2]).toMatchObject({
      method: "PATCH",
      route: "items/1/",
      body: { name: "patched" },
      tag: "config",
    });
    expect(transport.requests[3]).toMatchObject({
      method: "DELETE",
      route: "items/1/",
      tag: "delete",
    });
  });

  it("HttpTransport issues POST, PUT, PATCH, DELETE requests via fetch", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const mockFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    const transport = new HttpTransport({
      baseUrl: "https://awx.example.com",
      apiBasePath: "/api/v2/",
      readOnly: false,
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1" },
      fetch: mockFetch,
    });

    await transport.post("jobs/1/relaunch/", { relaunch_type: "failed" });
    await transport.put("templates/1/", { name: "t1" });
    await transport.patch("templates/1/", { description: "updated" });
    await transport.delete("templates/1/");

    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://awx.example.com/api/v2/jobs/1/relaunch/" });
    expect(calls[1]).toMatchObject({ method: "PUT", url: "https://awx.example.com/api/v2/templates/1/" });
    expect(calls[2]).toMatchObject({ method: "PATCH", url: "https://awx.example.com/api/v2/templates/1/" });
    expect(calls[3]).toMatchObject({ method: "DELETE", url: "https://awx.example.com/api/v2/templates/1/" });
  });

  it("runPlan dispatches write requests with method and tag to transport", async () => {
    const transport = new RecordedTransport(
      [{ status: 200, body: { id: 10 } }],
      { env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" } },
    );

    function* testPlan() {
      return yield* write("test/path/", { key: "val" }, "PUT", "config");
    }

    const res = await runPlan(testPlan(), { transport });
    expect(res.status).toBe(200);
    expect(transport.requests[0]).toMatchObject({
      method: "PUT",
      route: "test/path/",
      body: { key: "val" },
      tag: "config",
    });
  });
});

describe("transport safety gates (assertWritable)", () => {
  it("refuses all writes when AWX_AXI_READ_ONLY=1 is set", () => {
    const env = { AWX_AXI_READ_ONLY: "1" };

    expect(() => assertWritable(env, "POST", "jobs/1/cancel/")).toThrowError(AxiError);
    try {
      assertWritable(env, "POST", "jobs/1/cancel/");
    } catch (err) {
      const axiErr = err as AxiError;
      expect(axiErr.code).toBe("READ_ONLY_VIOLATION");
      expect(axiErr.message).toContain("this session is read-only and nothing was sent");
    }

    expect(() => assertWritable(env, "PUT", "templates/1/", "config")).toThrowError(AxiError);
    expect(() => assertWritable(env, "DELETE", "templates/1/", "delete")).toThrowError(AxiError);
  });

  it("refuses config writes when AWX_AXI_ALLOW_CONFIG_WRITES is not '1'", () => {
    const env = {};

    expect(() => assertWritable(env, "PUT", "templates/1/", "config")).toThrowError(AxiError);
    try {
      assertWritable(env, "PUT", "templates/1/", "config");
    } catch (err) {
      const axiErr = err as AxiError;
      expect(axiErr.code).toBe("CONFIG_WRITES_DISABLED");
      expect(axiErr.message).toContain("configuration writes are disabled");
    }

    // Explicitly allowed
    expect(() => assertWritable({ AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, "PUT", "templates/1/", "config")).not.toThrow();
  });

  it("refuses delete operations when AWX_AXI_ALLOW_DELETES is not '1'", () => {
    const env = {};

    expect(() => assertWritable(env, "DELETE", "templates/1/", "delete")).toThrowError(AxiError);
    try {
      assertWritable(env, "DELETE", "templates/1/", "delete");
    } catch (err) {
      const axiErr = err as AxiError;
      expect(axiErr.code).toBe("DELETE_WRITES_DISABLED");
      expect(axiErr.message).toContain("delete operations are disabled");
    }

    // Explicitly allowed
    expect(() => assertWritable({ AWX_AXI_ALLOW_DELETES: "1" }, "DELETE", "templates/1/", "delete")).not.toThrow();
  });

  it("refuses security writes when AWX_AXI_ALLOW_SECURITY_WRITES is not '1'", () => {
    const env = {};

    expect(() => assertWritable(env, "POST", "users/1/credentials/", "security")).toThrowError(AxiError);
    try {
      assertWritable(env, "POST", "users/1/credentials/", "security");
    } catch (err) {
      const axiErr = err as AxiError;
      expect(axiErr.code).toBe("SECURITY_WRITES_DISABLED");
      expect(axiErr.message).toContain("security writes are disabled");
    }

    // Explicitly allowed
    expect(() => assertWritable({ AWX_AXI_ALLOW_SECURITY_WRITES: "1" }, "POST", "users/1/credentials/", "security")).not.toThrow();
  });
});

describe("Captain's mandatory default dry-run policy across mutating commands", () => {
  it("defaults to --dry-run when invoked without --confirm", async () => {
    const run = await runCli(["template", "launch", "12", "--limit", "web-01"], {
      script: ["launch-preflight-accepts-limit"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).toContain("would_send: POST job_templates/12/launch/");
    expect(run.stdout).toContain("help[1]: Re-run with --confirm to launch");
    // No mutating request issued
    expect(run.transport.requests.every((r: RecordedRequest) => r.method === "GET")).toBe(true);
  });

  it("executes live mutation request when --confirm is passed", async () => {
    const run = await runCli(["template", "launch", "12", "--limit", "web-01", "--confirm"], {
      script: [
        "launch-preflight-accepts-limit",
        { status: 201, body: { id: 1844, status: "pending" } },
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("id: 1844");
    expect(run.transport.requests[1]).toMatchObject({
      method: "POST",
      route: "job_templates/12/launch/",
      body: { limit: "web-01" },
    });
  });

  it("refuses live execution with --confirm when AWX_AXI_READ_ONLY=1 is set", async () => {
    const run = await runCli(["template", "launch", "12", "--confirm"], {
      script: ["launch-preflight-accepts-limit"],
      env: { AWX_AXI_READ_ONLY: "1" },
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: READ_ONLY_VIOLATION");
    expect(run.stdout).toContain("this session is read-only");
  });
});
