import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("workflow template-node inspection", () => {
  it("lists editable template nodes with topology and node-type context", async () => {
    const run = await runCli(
      ["workflow", "template-nodes", "10", "--limit", "3"],
      { script: ["workflow-template-nodes"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "workflow_job_templates/10/workflow_nodes/",
      query: { page_size: 3 },
    });
    expect(run.stdout).toContain("workflow_template_nodes");
    expect(run.stdout).toContain("build");
    expect(run.stdout).toContain("Deploy web tier");
    expect(run.stdout).toContain("Prod release gate");
    expect(run.stdout).toContain("approval");
    expect(run.stdout).toContain("success_nodes");
    expect(run.stdout).toContain("failure_nodes");
    expect(run.stdout).toContain("always_nodes");
    expect(run.stdout).toContain("all_parents_must_converge");
    expect(run.stdout).toContain("prompt_fields");
    expect(run.stdout).toContain("Control EE");
  });

  it("follows AWX next links until the requested node limit is met", async () => {
    const firstPage = {
      status: 200,
      body: {
        count: 3,
        next: "/api/v2/workflow_job_templates/10/workflow_nodes/?page=2",
        results: [
          {
            id: 71,
            identifier: "build",
            unified_job_template: 12,
            success_nodes: [72],
            failure_nodes: [],
            always_nodes: [],
            summary_fields: {
              unified_job_template: { id: 12, name: "Deploy web tier", unified_job_type: "job" },
            },
          },
        ],
      },
    };
    const secondPage = {
      status: 200,
      body: {
        count: 3,
        next: null,
        results: [
          {
            id: 72,
            identifier: "approval",
            unified_job_template: 30,
            success_nodes: [],
            failure_nodes: [],
            always_nodes: [],
            summary_fields: {
              unified_job_template: { id: 30, name: "Prod release gate", unified_job_type: "workflow_approval", timeout: 3600 },
            },
          },
          {
            id: 74,
            identifier: "smoke",
            unified_job_template: 22,
            success_nodes: [],
            failure_nodes: [],
            always_nodes: [],
            summary_fields: {
              unified_job_template: { id: 22, name: "Smoke test", unified_job_type: "job" },
            },
          },
        ],
      },
    };
    const run = await runCli(
      ["workflow", "template-nodes", "10", "--limit", "2"],
      { script: [firstPage, secondPage] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests[1]?.route).toBe(
      "/api/v2/workflow_job_templates/10/workflow_nodes/",
    );
    expect(run.stdout).toContain("count: 2 of 3 total");
    expect(run.stdout).toContain("build");
    expect(run.stdout).toContain("approval");
    expect(run.stdout).not.toContain("Smoke test");
  });

  it("resolves a workflow template name before listing its template graph", async () => {
    const run = await runCli(
      ["workflow", "template-nodes", "Release pipeline"],
      { script: ["workflow-list", "workflow-template-nodes"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "workflow_job_templates/",
      "workflow_job_templates/10/workflow_nodes/",
    ]);
    expect(run.transport.requests[0]?.query).toEqual({ name: "Release pipeline" });
    expect(run.stdout).toContain("workflow_template_nodes");
  });

  it("shows a template node with prompts, safe relations, and all edge targets", async () => {
    const run = await runCli(
      ["workflow", "template-node", "71"],
      {
        script: [
          "workflow-template-node-detail",
          "workflow-template-node-credentials",
          "workflow-template-node-success",
          "workflow-template-node-failure",
          "workflow-template-node-always",
        ],
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.map((request) => request.route)).toEqual([
      "workflow_job_template_nodes/71/",
      "workflow_job_template_nodes/71/credentials/",
      "workflow_job_template_nodes/71/success_nodes/",
      "workflow_job_template_nodes/71/failure_nodes/",
      "workflow_job_template_nodes/71/always_nodes/",
    ]);
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
    expect(run.stdout).toContain("workflow_template_node");
    expect(run.stdout).toContain("workflow_template: 10 (Release pipeline)");
    expect(run.stdout).toContain("unified_job_type: job");
    expect(run.stdout).toContain("unified_job_template: 12 (Deploy web tier)");
    expect(run.stdout).toContain("Production inventory");
    expect(run.stdout).toContain("SSH deploy");
    expect(run.stdout).toContain("Control EE");
    expect(run.stdout).toContain("all_parents_must_converge: true");
    expect(run.stdout).toContain("release");
    expect(run.stdout).toContain("success_nodes");
    expect(run.stdout).toContain("Prod release gate");
    expect(run.stdout).toContain("Rollback release");
    expect(run.stdout).toContain("Smoke test");
  });

  it("identifies an approval node and a unified-template node without reading run nodes", async () => {
    const run = await runCli(
      ["workflow", "template-node", "72", "--limit", "20"],
      {
        script: [
          {
            status: 200,
            body: {
              id: 72,
              workflow_job_template: 10,
              identifier: "approval",
              unified_job_template: 30,
              all_parents_must_converge: true,
              success_nodes: [],
              failure_nodes: [],
              always_nodes: [],
              summary_fields: {
                workflow_job_template: { id: 10, name: "Release pipeline" },
                unified_job_template: {
                  id: 30,
                  name: "Prod release gate",
                  description: "Approve production release",
                  unified_job_type: "workflow_approval",
                  timeout: 3600,
                },
              },
            },
          },
          { status: 200, body: { count: 0, next: null, results: [] } },
          { status: 200, body: { count: 0, next: null, results: [] } },
          { status: 200, body: { count: 0, next: null, results: [] } },
          { status: 200, body: { count: 0, next: null, results: [] } },
        ],
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("unified_job_type: workflow_approval");
    expect(run.stdout).toContain("approval:");
    expect(run.stdout).toContain("Prod release gate");
    expect(run.stdout).toContain("timeout: 3600");
    expect(run.stdout).toContain("credentials: []");
    expect(run.stdout).toContain("credentials_total: 0");
    expect(run.transport.requests.every((request) => !request.route.includes("workflow_jobs/"))).toBe(true);
  });

  it("recursively redacts prompt values and nested data", async () => {
    const run = await runCli(
      ["workflow", "template-node", "71"],
      {
        script: [
          "workflow-template-node-detail",
          "workflow-template-node-credentials",
          "workflow-template-node-success",
          "workflow-template-node-failure",
          "workflow-template-node-always",
        ],
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('release: "2026.07"');
    expect(run.stdout).toContain("password: ***");
    expect(run.stdout).toContain("api_key: ***");
    expect(run.stdout).toContain("private_key: ***");
    expect(run.stdout).not.toContain("do-not-print");
    expect(run.stdout).not.toContain("also-do-not-print");
    expect(run.stdout).not.toContain("block-do-not-print");
    expect(run.stdout).not.toContain("user:secret@");
    expect(run.stdout).not.toContain("$encrypted$vault-value");
  });

  it("bounds very large prompt objects with explicit omission metadata", async () => {
    const extraData: Record<string, string> = { password: "do-not-print" };
    for (let index = 0; index < 1000; index += 1) {
      extraData[`field_${String(index).padStart(4, "0")}`] = `value-${index}`;
    }
    const detail = {
      status: 200,
      body: {
        id: 71,
        workflow_job_template: 10,
        extra_data: extraData,
        summary_fields: {},
      },
    };
    const empty = { status: 200, body: { count: 0, next: null, results: [] } };

    const run = await runCli(
      ["workflow", "template-node", "71"],
      { script: [detail, empty, empty, empty, empty] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("password: ***");
    expect(run.stdout).toContain("__awx_axi_omitted__");
    expect(run.stdout).toContain("reason: item_limit");
    expect(run.stdout).toContain("count: 901");
    expect(run.stdout).not.toContain("do-not-print");
    expect(run.stdout).not.toContain("field_0999");
    expect(run.stdout.length).toBeLessThan(10_000);
  });

  it("bounds extreme prompt depth with explicit omission metadata", async () => {
    let extraData: Record<string, unknown> = { leaf: "unbounded" };
    for (let depth = 0; depth < 100; depth += 1) {
      extraData = { nested: extraData };
    }
    const detail = {
      status: 200,
      body: {
        id: 71,
        workflow_job_template: 10,
        extra_data: extraData,
        summary_fields: {},
      },
    };
    const empty = { status: 200, body: { count: 0, next: null, results: [] } };

    const run = await runCli(
      ["workflow", "template-node", "71"],
      { script: [detail, empty, empty, empty, empty] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("__awx_axi_omitted__");
    expect(run.stdout).toContain("reason: depth_limit");
    expect(run.stdout).not.toContain("unbounded");
    expect(run.stdout.length).toBeLessThan(5_000);
  });

  it("rejects an invalid node limit before contacting the controller", async () => {
    const run = await runCli(
      ["workflow", "template-nodes", "10", "--limit", "0"],
      { script: [] },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("--limit must be a positive integer");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("reports a deterministic empty graph", async () => {
    const run = await runCli(
      ["workflow", "template-nodes", "10"],
      { script: ["workflow-template-nodes-empty"] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("workflow_template_nodes: 0 workflow template nodes found for workflow template 10");
    expect(run.stdout).toContain("workflow template-node <id>");
  });

  it("reports a missing workflow template name before reading its nodes", async () => {
    const empty = {
      status: 200,
      body: { count: 0, next: null, previous: null, results: [] },
    };
    const run = await runCli(
      ["workflow", "template-nodes", "Missing pipeline"],
      { script: [empty, empty] },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NAME_NOT_FOUND");
    expect(run.stdout).toContain('no workflow job template is named \\"Missing pipeline\\"');
    expect(run.transport.requests).toHaveLength(2);
    expect(run.transport.requests.every((request) => request.route === "workflow_job_templates/")).toBe(true);
  });

  it("translates a missing numeric node and does not issue relationship reads", async () => {
    const run = await runCli(
      ["workflow", "template-node", "999"],
      { script: [{ status: 404, body: { detail: "Not found." } }] },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: NOT_FOUND");
    expect(run.stdout).toContain("workflow template node 999");
    expect(run.transport.requests).toHaveLength(1);
  });

  it("uses the shared page-size limit for each node relation", async () => {
    const empty = { status: 200, body: { count: 0, next: null, results: [] } };
    const run = await runCli(
      ["workflow", "template-node", "71", "--limit", "7"],
      { script: ["workflow-template-node-detail", empty, empty, empty, empty] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests.slice(1).every((request) => request.query.page_size === 7)).toBe(true);
  });

  it("is available in read-only mode and reads safe credential context with GET requests", async () => {
    const run = await runCli(
      ["workflow", "template-node", "71"],
      {
        script: [
          "workflow-template-node-detail",
          "workflow-template-node-credentials",
          "workflow-template-node-success",
          "workflow-template-node-failure",
          "workflow-template-node-always",
        ],
        env: {
          AWX_AXI_READ_ONLY: "1",
          AWX_AXI_ALLOW_CONFIG_WRITES: "0",
          AWX_AXI_ALLOW_DELETES: "0",
          AWX_AXI_ALLOW_SECURITY_WRITES: "0",
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[1]?.route).toBe(
      "workflow_job_template_nodes/71/credentials/",
    );
    expect(run.transport.requests.every((request) => request.method === "GET")).toBe(true);
    expect(run.stdout).toContain("SSH deploy");
    expect(run.stdout).toContain("credential_type: 1 (Machine)");
    expect(run.stdout).toContain("credentials_total: 1");
    expect(run.stdout).not.toContain("credential-password-do-not-print");
    expect(run.stdout).not.toContain("credential-private-key-do-not-print");
  });

  it("documents the template graph commands separately from run-node inspection", async () => {
    const listHelp = await runCli(["workflow", "template-nodes", "--help"], { script: [] });
    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stdout).toContain("workflow template-nodes <id|name> [--limit <n>]");
    expect(listHelp.stdout).toContain("distinct from");

    const showHelp = await runCli(["workflow", "template-node", "--help"], { script: [] });
    expect(showHelp.exitCode).toBe(0);
    expect(showHelp.stdout).toContain("workflow template-node <id> [--limit <n>]");
    expect(showHelp.stdout).toContain("workflow nodes <run-id>");

    const nounHelp = await runCli(["workflow", "--help"], { script: [] });
    expect(nounHelp.exitCode).toBe(0);
    expect(nounHelp.stdout).toContain("editable template graph");
  });
});
