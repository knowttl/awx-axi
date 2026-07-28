import { describe, expect, it } from "vitest";

import {
  HttpTransport,
  RecordedTransport,
  interpretText,
} from "../src/core/transport.js";
import { assertNoCountDisabled } from "../src/core/paginate.js";
import { exchange, fixtureFetch, loadFixture } from "./support/fixtures.js";

const BASE = "https://awx.example.com";

function transport(
  fixtures: readonly string[],
  options: { readOnly?: boolean } = {},
): { transport: HttpTransport; calls: ReturnType<typeof fixtureFetch>["calls"] } {
  const { fetch, calls } = fixtureFetch(fixtures);
  return {
    transport: new HttpTransport({
      baseUrl: BASE,
      authorization: "Bearer test",
      readOnly: options.readOnly ?? false,
      fetch,
    }),
    calls,
  };
}

describe("getPaged (design.md §4.3 cases 1-3)", () => {
  it("follows the envelope's next link rather than inferring page boundaries", async () => {
    const { transport: http, calls } = transport([
      "unified-jobs-page-1",
      "unified-jobs-page-2",
      "unified-jobs-page-3",
    ]);

    const result = await http.getPaged(
      "/api/v2/unified_jobs/",
      { type: "job" },
      450,
    );

    // The client asked for 450 rows in one page; AWX capped page_size at 200
    // and said so only through the next link, so three reads are required.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url.searchParams.get("page_size")).toBe("450");
    expect(calls[1]?.url.searchParams.get("page_size")).toBe("200");
    expect(calls[1]?.url.searchParams.get("page")).toBe("2");
    expect(result.rows).toHaveLength(450);
    expect(result.count).toBe(512);
  });

  it("reports the server's own count, never one inferred from the rows", async () => {
    const { transport: http } = transport(["unified-jobs-page-1"]);

    const result = await http.getPaged("/api/v2/unified_jobs/", {}, 200);

    expect(result.rows).toHaveLength(200);
    expect(result.count).toBe(512);
  });

  it("never sends count_disabled", async () => {
    const { transport: http, calls } = transport([
      "unified-jobs-page-1",
      "unified-jobs-page-2",
      "unified-jobs-page-3",
    ]);

    await http.getPaged("/api/v2/unified_jobs/", { type: "job" }, 450);

    for (const call of calls) {
      expect(call.url.search).not.toContain("count_disabled");
    }
  });

  it("refuses a caller that tries to send count_disabled", () => {
    expect(() => assertNoCountDisabled({ count_disabled: true })).toThrow(
      /count_disabled is never sent/,
    );
  });

  it("sends page_size and never limit, so an event list keeps its count", async () => {
    const { transport: http, calls } = transport(["job-events-page"]);

    const result = await http.getPaged(
      "/api/v2/jobs/1839/job_events/",
      { failed: true },
      50,
    );

    expect(calls[0]?.url.searchParams.get("page_size")).toBe("50");
    expect(calls[0]?.url.searchParams.has("limit")).toBe(false);
    expect(result.count).toBe(231);
  });
});

describe("getText (design.md §4.3 case 4)", () => {
  it("surfaces the oversized-output apology as a typed condition, not as content", async () => {
    const { transport: http } = transport(["stdout-too-large"]);

    const text = await http.getText("/api/v2/jobs/1839/stdout/", {
      format: "json",
      start_line: 0,
    });

    // The controller answered 200, which is exactly the trap.
    expect(text.status).toBe(200);
    expect(text.tooLarge).toBe(true);
    expect(text.sizeBytes).toBe(3_355_443);
    expect(text.displayLimitBytes).toBe(1_048_576);
    // The apology never survives as content, so it cannot be printed as output.
    expect(text.content).toBe("");
    expect(text.absoluteEnd).toBe(1);
  });

  it("passes an ordinary ranged read through untouched", async () => {
    const { transport: http } = transport(["stdout-ranged"]);

    const text = await http.getText("/api/v2/project_updates/1846/stdout/");

    expect(text.tooLarge).toBe(false);
    expect(text.rangeStart).toBe(4013);
    expect(text.absoluteEnd).toBe(4212);
    expect(text.content).toContain("PLAY RECAP");
  });

  it("recognizes the apology whatever range the caller asked for", () => {
    const fixture = loadFixture("stdout-too-large");

    const text = interpretText({
      status: fixture.status,
      headers: new Headers(),
      body: fixture.body,
    });

    expect(text.tooLarge).toBe(true);
  });
});

describe("status codes (design.md §3.2)", () => {
  it("preserves a 405 on the response rather than throwing", async () => {
    const { transport: http } = transport(["cancel-405"]);

    const response = await http.post("/api/v2/jobs/1839/cancel/");

    expect(response.status).toBe(405);
  });

  it("preserves a 403 body for translation rather than swallowing it", async () => {
    const { transport: http } = transport(["error-detail"]);

    const response = await http.get("/api/v2/job_templates/12/");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      detail: "You do not have permission to perform this action.",
    });
  });
});

describe("the read-only boundary (design.md §6.5)", () => {
  it("refuses a POST and issues nothing at all", async () => {
    const { transport: http, calls } = transport(["launch-201-ignored-fields"], {
      readOnly: true,
    });

    await expect(
      http.post("/api/v2/job_templates/12/launch/", { limit: "db-02" }),
    ).rejects.toMatchObject({
      code: "READ_ONLY_VIOLATION",
      message: expect.stringContaining("POST /api/v2/job_templates/12/launch/"),
    });

    // The proof is here, not in the thrown error: nothing reached the wire.
    expect(calls).toHaveLength(0);
  });

  it("still allows reads while the boundary is in force", async () => {
    const { transport: http, calls } = transport(["job-detail-terminal"], {
      readOnly: true,
    });

    const response = await http.get("/api/v2/jobs/1839/");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses on the recorded transport too, and records no request", async () => {
    const recorded = new RecordedTransport([exchange("cancel-405")], {
      readOnly: true,
    });

    await expect(
      recorded.post("/api/v2/jobs/1841/cancel/"),
    ).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    expect(recorded.requests).toHaveLength(0);
  });
});

describe("network failures (design.md §9.1)", () => {
  it("maps a refused connection to CONTROLLER_UNREACHABLE", async () => {
    const http = new HttpTransport({
      baseUrl: BASE,
      readOnly: false,
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          }),
        ),
    });

    await expect(http.get("/api/v2/ping/")).rejects.toMatchObject({
      code: "CONTROLLER_UNREACHABLE",
    });
  });

  it("maps a certificate failure to TLS_UNTRUSTED", async () => {
    const http = new HttpTransport({
      baseUrl: BASE,
      readOnly: false,
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("self signed certificate"), {
              code: "DEPTH_ZERO_SELF_SIGNED_CERT",
            }),
          }),
        ),
    });

    await expect(http.get("/api/v2/ping/")).rejects.toMatchObject({
      code: "TLS_UNTRUSTED",
    });
  });
});
