import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { runCli } from "./support/run.js";

const detail = { status: 200, body: { id: 1 } };
const empty = { status: 200, body: { count: 0, next: null, results: [] } };
const internalReads = [
  { command: ["host", "show", "1"], field: "host.groups", before: [detail], after: [detail, detail] },
  { command: ["group", "show", "1"], field: "group.hosts", before: [detail], after: [empty, detail] },
  { command: ["group", "show", "1"], field: "group.children", before: [detail, empty], after: [detail] },
  { command: ["execution-environment", "show", "1"], field: "execution_environment.unified_job_templates", before: [detail], after: [] },
  { command: ["inventory-source", "show", "1"], field: "inventory_source.updates", before: [detail], after: [] },
  { command: ["system-job-template", "show", "1"], field: "system_job_template.jobs", before: [detail], after: [empty] },
  { command: ["system-job-template", "show", "1"], field: "system_job_template.schedules", before: [detail, empty], after: [] },
];

describe("internal pagination consumers", () => {
  it.each(internalReads)("reads all $field past the list page budget", async ({ command, field, before, after }) => {
    const run = await runCli(command, {
      script: [
        ...before,
        ...Array.from({ length: 149 }, (_, index) => ({
          status: 200,
          body: { count: 150, next: `/api/v2/items/?page=${index + 2}`, results: [{ id: index + 1, name: `item ${index + 1}` }] },
        })),
        { status: 200, body: { count: 150, next: null, results: [{ id: 150, name: "last item" }] } },
        ...after,
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(before.length + 150 + after.length);
    expect(decode(run.stdout)).toHaveProperty(`${field}.length`, 150);
    expect(run.stdout).toContain("last item");
  });

  it.each(internalReads)("refuses partial $field and preserves continuation", async ({ command, field, before }) => {
    const run = await runCli(command, {
      script: [...before, {
        status: 200,
        body: { count: 150, next: "/api/v2/items/?page=2", results: [] },
      }],
    });
    expect(run.exitCode).toBe(1);
    const output = decode(run.stdout);
    expect(output).toMatchObject({
      code: "INCOMPLETE_COLLECTION", count: 150,
      pagination: { truncated: true, stop: "empty-page", next: "/api/v2/items/?page=2" },
    });
    expect(output).not.toHaveProperty(field);
  });
});

describe("bounded pagination consumers", () => {
  it.each([
    ["team", "list"], ["team", "users", "1"], ["team", "projects", "1"],
    ["team", "credentials", "1"], ["team", "roles", "1"],
    ["team", "object-roles", "1"], ["team", "access-list", "1"],
    ["system-job", "list"],
    ["inventory-source", "list"], ["host", "list"], ["group", "list"],
    ["schedule", "list"], ["ad-hoc", "list"], ["ad-hoc", "events", "1"],
    ["credential", "list"], ["credential", "object-roles", "1"], ["notification", "list"],
    ["role", "list"], ["role", "parents", "1"], ["role", "children", "1"],
    ["role", "users", "1"], ["role", "teams", "1"], ["user", "list"],
    ["project", "list"], ["project", "updates", "1"], ["project", "roles", "1"],
    ["activity-stream", "list"], ["organization", "list"],
    ["template", "list"], ["template", "object-roles", "1"],
    ["system-job-template", "list"], ["notification-template", "list"], ["execution-environment", "list"],
  ])("%j discloses an incomplete empty page", async (...command) => {
    const run = await runCli(command, {
      script: [{ status: 200, body: { count: 7, next: "/api/v2/items/?page=2", results: [] } }],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(decode(run.stdout)).toMatchObject({
      count: "0 of 7 total",
      pagination: { truncated: true, stop: "empty-page", next: "/api/v2/items/?page=2" },
    });
    expect(run.stdout).toContain("0 rows returned; collection is incomplete");
  });

  it.each(["events", "notifications"])("system-job %s discloses pagination after resolving the job type", async (command) => {
    const run = await runCli(["system-job", command, "1"], {
      script: [
        { status: 200, body: { count: 1, next: null, results: [{ id: 1, type: "system_job" }] } },
        { status: 200, body: { count: 7, next: "/api/v2/items/?page=2", results: [] } },
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(decode(run.stdout)).toMatchObject({
      count: "0 of 7 total",
      pagination: { truncated: true, stop: "empty-page", next: "/api/v2/items/?page=2" },
    });
    expect(run.stdout).toContain("0 rows returned; collection is incomplete");
  });
});
