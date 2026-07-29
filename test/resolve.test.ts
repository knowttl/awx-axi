import { describe, expect, it } from "vitest";

import { runPlan } from "../src/core/registry.js";
import { resolveId } from "../src/core/resolve.js";
import { RecordedTransport } from "../src/core/transport.js";
import { exchange, loadFixture } from "./support/fixtures.js";

const OPTIONS = {
  listRoute: "job_templates/",
  noun: "job template",
  listCommand: "template list",
  command: "template launch",
} as const;

function resolve(
  value: string,
  fixtures: readonly string[],
): { result: Promise<number>; transport: RecordedTransport } {
  const transport = new RecordedTransport(fixtures.map((name) => exchange(name)));
  return {
    result: runPlan(resolveId(value, OPTIONS), { transport }),
    transport,
  };
}

/**
 * Name resolution by filtered query (design.md §7.3), with its three honest
 * outcomes. Named URLs are avoided entirely, which is what §4.3 case 5 forces.
 */
describe("resolving an <id|name> argument", () => {
  it("costs no request at all for a numeric id", async () => {
    const { result, transport } = resolve("1839", []);

    await expect(result).resolves.toBe(1839);
    expect(transport.requests).toHaveLength(0);
  });

  it("resolves exactly one match by filtered query", async () => {
    const { result, transport } = resolve("Deploy web tier", [
      "job-templates-name-one",
    ]);

    await expect(result).resolves.toBe(12);
    expect(transport.requests[0]).toMatchObject({
      method: "GET",
      route: "job_templates/",
      query: { name: "Deploy web tier" },
    });
  });

  it("falls back to a case-insensitive match before giving up", async () => {
    const { result, transport } = resolve("deploy web tier", [
      "job-templates-name-none",
      "job-templates-name-one",
    ]);

    await expect(result).resolves.toBe(12);
    expect(transport.requests[1]?.query).toEqual({
      name__iexact: "deploy web tier",
    });
  });

  it("reports zero matches as NAME_NOT_FOUND, naming permission as a cause", async () => {
    const { result } = resolve("Deploy everything", [
      "job-templates-name-none",
      "job-templates-name-none",
    ]);

    await expect(result).rejects.toMatchObject({
      code: "NAME_NOT_FOUND",
      suggestions: [
        expect.stringContaining("--search"),
        expect.stringContaining("cannot see"),
      ],
    });
  });

  it("refuses an ambiguous name rather than picking the oldest match", async () => {
    const { result } = resolve("Deploy web tier", [
      "job-templates-name-ambiguous",
    ]);

    await expect(result).rejects.toMatchObject({
      code: "AMBIGUOUS_NAME",
      details: {
        candidates: [
          { id: 12, name: "Deploy web tier", organization: "Production" },
          { id: 41, name: "Deploy web tier", organization: "Staging" },
        ],
      },
      // §7.3's own example: a complete command the agent can run as-is.
      suggestions: [
        "Re-run with the id, e.g. `awx-axi template launch 12`",
      ],
    });
  });

  it("reports the envelope's total, and says when the candidates are partial", async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: {
          count: 30,
          next: "/api/v2/job_templates/?name=Deploy+web+tier&page=2",
          results: [
            { id: 12, name: "Deploy web tier" },
            { id: 41, name: "Deploy web tier" },
          ],
        },
      },
    ]);

    await expect(
      runPlan(resolveId("Deploy web tier", OPTIONS), { transport }),
    ).rejects.toMatchObject({
      // 30 from the envelope, not the 2 rows this page happened to carry.
      message: '30 job templates are named "Deploy web tier"',
      suggestions: [
        "Re-run with the id, e.g. `awx-axi template launch 12`",
        expect.stringContaining("Only 2 of the 30 candidates are listed above"),
      ],
    });
  });

  it("never constructs a named URL (§4.3 case 5)", async () => {
    const { result, transport } = resolve("Deploy web tier", [
      "job-templates-name-one",
    ]);
    await result;

    // A named-URL lookup would have been `job_templates/Deploy web
    // tier++Production/`, and a 403 on it is rewritten to the same `Not found.`
    // a missing object returns - so a named lookup cannot tell "does not exist"
    // from "you cannot see it".
    const invisible = loadFixture("named-url-403-as-404");
    expect(invisible.status).toBe(404);
    expect(invisible.body).toEqual({ detail: "Not found." });

    for (const request of transport.requests) {
      expect(request.route).toBe("job_templates/");
    }
  });
});
