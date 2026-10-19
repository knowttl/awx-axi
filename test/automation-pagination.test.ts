import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { runCli } from "./support/run.js";

const systemJob = { status: 200, body: { count: 1, next: null, results: [{ id: 1, type: "system_job" }] } };
const collections = [
  { command: ["ad-hoc", "list"], limit: 100, label: "ad_hoc_commands", fields: "id,name,status,created,started,finished,inventory,credential", before: [] },
  { command: ["ad-hoc", "events", "1"], limit: 50, label: "events", fields: "id,event,host,task,failed,changed", before: [] },
  { command: ["template", "list"], limit: 100, label: "job_templates", fields: "id,name,project,last_job_run", before: [] },
  { command: ["template", "object-roles", "1"], limit: 100, label: "object_roles", fields: "id,name,description,type", before: [] },
  { command: ["project", "list"], limit: 100, label: "projects", fields: "id,name,scm_type,status,last_job_run", before: [] },
  { command: ["project", "updates", "1"], limit: 20, label: "updates", fields: "id,name,status,finished", before: [] },
  { command: ["project", "roles", "1"], limit: 100, label: "roles", fields: "id,name,description,type", before: [] },
  { command: ["schedule", "list"], limit: 100, label: "schedules", fields: "id,name,template,enabled,next_run", before: [] },
  { command: ["system-job", "list"], limit: 100, label: "system_jobs", fields: "id,name,template,status,type,started,finished", before: [] },
  { command: ["system-job", "events", "1"], limit: 50, label: "events", fields: "id,event,host,task,failed,changed", before: [systemJob] },
  { command: ["system-job", "notifications", "1"], limit: 50, label: "notifications", fields: "id,template,status,created,errors,subject", before: [systemJob] },
  { command: ["system-job-template", "list"], limit: 100, label: "system_job_templates", fields: "id,name,type,status,last_run", before: [] },
  { command: ["inventory-source", "list"], limit: 100, label: "inventory_sources", fields: "id,name,inventory,organization,source,status", before: [] },
  { command: ["execution-environment", "list"], limit: 100, label: "execution_environments", fields: "id,name,type,organization,image", before: [] },
];

const row = { id: 1, name: "example", description: "detail", extra: "not a default field" };
const first = { status: 200, body: { count: 3, next: "/api/v2/items/?page=2", results: [row] } };
const second = { status: 200, body: { count: 3, next: "/api/v2/items/?page=3", results: [{ ...row, id: 2 }] } };

describe.each(collections)("automation collection $command", ({ command, limit, label, fields, before }) => {
  it("accepts all and stops at the requested row budget", async () => {
    const run = await runCli([...command, "--all", "--max-rows", "2"], { script: [...before, first, second] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(before.length + 2);
    expect(decode(run.stdout)).toMatchObject({
      count: "2 of 3 total",
      pagination: { max_rows: 2, truncated: true, stop: "row-budget", next: "/api/v2/items/?page=3" },
    });
  });

  it("accepts all with its default budget", async () => {
    const run = await runCli([...command, "--all"], { script: [...before, { status: 200, body: { count: 1, next: null, results: [row] } }] });
    expect(run.exitCode).toBe(0);
    expect(decode(run.stdout)).toMatchObject({ pagination: { max_rows: 10000, truncated: false, stop: "complete" } });
  });

  it("honors an explicit limit without following the next page", async () => {
    const run = await runCli([...command, "--limit", "1"], { script: [...before, first] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(before.length + 1);
    expect(decode(run.stdout)).toMatchObject({ count: "1 of 3 total", pagination: { max_rows: 1, stop: "row-budget" } });
  });

  it("preserves the default limit and row projection", async () => {
    const run = await runCli(command, { script: [...before, { status: 200, body: { count: 1, next: null, results: [row] } }] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.at(-1)?.query.page_size).toBe(limit);
    const output = decode(run.stdout) as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(output[label]![0]!)).toEqual(fields.split(","));
  });

  it.each([
    ["--limit"], ["--limit", "0"], ["--limit", "1001"], ["--limit", "1.5"],
    ["--limit", "1e2"], ["--all", "--limit", "2"], ["--max-rows", "2"],
    ["--all", "--max-rows"], ["--all", "--max-rows", "0"], ["--all", "--max-rows", "10001"],
  ])("rejects invalid controls %j before any read", async (...flags) => {
    const run = await runCli([...command, ...flags]);
    expect(run.exitCode).toBe(2);
    expect(run.transport.requests).toHaveLength(0);
  });

  it("documents shared pagination flags in command help", async () => {
    const run = await runCli([...command, "--help"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("--all");
    expect(run.stdout).toContain("--max-rows");
    expect(run.transport.requests).toHaveLength(0);
  });
});
