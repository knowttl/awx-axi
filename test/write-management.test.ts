import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("write-management coverage", () => {
  it("creates, edits, and deletes organizations with the config/delete gates", async () => {
    const created = await runCli(["organization", "create", "Operations", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      script: [{ status: 201, body: { id: 10, name: "Operations" } }],
    });
    expect(created.transport.requests[0]).toMatchObject({ method: "POST", route: "organizations/", tag: "config" });

    const edited = await runCli(["organization", "edit", "10", "--description", "Ops", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      script: [{ status: 200, body: { id: 10, name: "Operations" } }],
    });
    expect(edited.transport.requests[0]).toMatchObject({ method: "PATCH", route: "organizations/10/", tag: "config" });

    const deleted = await runCli(["organization", "delete", "10", "--confirm"], {
      env: { AWX_AXI_ALLOW_DELETES: "1" },
      script: [{ status: 204 }],
    });
    expect(deleted.transport.requests[0]).toMatchObject({ method: "DELETE", route: "organizations/10/", tag: "delete" });
  });

  it("uses the security gate for organization associations", async () => {
    const run = await runCli(["organization", "team-add", "10", "--team", "20", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
      script: [{ status: 204 }],
    });
    expect(run.transport.requests[0]).toMatchObject({ method: "POST", route: "organizations/10/teams/", body: { id: 20 }, tag: "security" });
  });

  it("manages execution environments", async () => {
    const create = await runCli(["execution-environment", "create", "base", "--image", "quay.io/base", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, script: [{ status: 201, body: { id: 4, name: "base", image: "quay.io/base" } }],
    });
    expect(create.transport.requests[0]).toMatchObject({ method: "POST", route: "execution_environments/", body: { name: "base", image: "quay.io/base" }, tag: "config" });

    const remove = await runCli(["execution-environment", "delete", "4", "--confirm"], {
      env: { AWX_AXI_ALLOW_DELETES: "1" }, script: [{ status: 204 }],
    });
    expect(remove.transport.requests[0]).toMatchObject({ method: "DELETE", route: "execution_environments/4/", tag: "delete" });
  });

  it("manages notification templates and tests them", async () => {
    const create = await runCli(["notification-template", "create", "mail", "--organization", "1", "--notification-type", "email", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, script: [{ status: 201, body: { id: 7, name: "mail" } }],
    });
    expect(create.transport.requests[0]).toMatchObject({ method: "POST", route: "notification_templates/", tag: "config" });
    const test = await runCli(["notification-template", "test", "7", "--confirm"], {
      script: [{ status: 202, body: { notification: 99 } }],
    });
    expect(test.transport.requests[0]).toMatchObject({ method: "POST", route: "notification_templates/7/test/", tag: "operational" });
  });

  it("launches system job templates and cancels system jobs", async () => {
    const launch = await runCli(["system-job-template", "launch", "3", "--confirm"], {
      script: [{ status: 201, body: { system_job: 44, status: "pending" } }],
    });
    expect(launch.transport.requests[0]).toMatchObject({ method: "POST", route: "system_job_templates/3/launch/", tag: "operational" });
    const cancel = await runCli(["system-job", "cancel", "44", "--confirm"], {
      script: [{ status: 200, body: { count: 1, results: [{ id: 44, type: "system_job" }] } }, { status: 202 }],
    });
    expect(cancel.transport.requests[1]).toMatchObject({ method: "POST", route: "system_jobs/44/cancel/", tag: "operational" });
  });

  it("manages inventory groups, sources, and bulk hosts", async () => {
    const group = await runCli(["inventory", "group-create", "web", "--inventory", "2", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, script: [{ status: 201, body: { id: 8, name: "web" } }],
    });
    expect(group.transport.requests[0]).toMatchObject({ method: "POST", route: "inventories/2/groups/", tag: "config" });
    const source = await runCli(["inventory", "source-create", "cloud", "--inventory", "2", "--source", "ec2", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, script: [{ status: 201, body: { id: 9, name: "cloud" } }],
    });
    expect(source.transport.requests[0]).toMatchObject({ method: "POST", route: "inventory_sources/", body: { inventory: 2, source: "ec2", name: "cloud" }, tag: "config" });
  });

  it("manages template, workflow, project, and schedule associations", async () => {
    const template = await runCli(["template", "credential-add", "12", "--credential", "5", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" }, script: [{ status: 204 }],
    });
    expect(template.transport.requests[0]).toMatchObject({ method: "POST", route: "job_templates/12/credentials/", body: { id: 5 }, tag: "security" });
    const workflow = await runCli(["workflow", "node-create", "30", "--template", "12", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, script: [{ status: 201, body: { id: 31 } }],
    });
    expect(workflow.transport.requests[0]).toMatchObject({ method: "POST", route: "workflow_job_templates/30/workflow_nodes/", body: { unified_job_template: 12 }, tag: "config" });
    const project = await runCli(["project", "notification-add", "2", "--event", "success", "--notification-template", "7", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" }, script: [{ status: 204 }],
    });
    expect(project.transport.requests[0]).toMatchObject({ method: "POST", route: "projects/2/notification_templates_success/", tag: "config" });
    const schedule = await runCli(["schedule", "credential-add", "6", "--credential", "5", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" }, script: [{ status: 204 }],
    });
    expect(schedule.transport.requests[0]).toMatchObject({ method: "POST", route: "schedules/6/credentials/", tag: "security" });
  });

  it("creates team credentials and manages user tokens without exposing secrets", async () => {
    const team = await runCli(["team", "credential-create", "4", "--name", "team-key", "--credential-type", "2", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" }, script: [{ status: 201, body: { id: 12, name: "team-key" } }],
    });
    expect(team.transport.requests[0]).toMatchObject({ method: "POST", route: "teams/4/credentials/", tag: "security" });
    const token = await runCli(["user", "token-create", "3", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" }, script: [{ status: 201, body: { id: 55, token: "must-not-print", scope: "write" } }],
    });
    expect(token.transport.requests[0]).toMatchObject({ method: "POST", route: "users/3/personal_tokens/", tag: "security" });
    expect(token.stdout).not.toContain("must-not-print");
  });

  it("keeps new mutations dry-run by default", async () => {
    const run = await runCli(["system-job-template", "launch", "3"], { script: [] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(0);
    expect(run.stdout).toContain("dry_run:");
  });
});
