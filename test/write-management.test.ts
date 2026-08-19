import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(test.stdout).toContain("pending");
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
    expect(cancel.stdout).toContain("cancel_requested");
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

  it("revokes numeric token ids through the security gate", async () => {
    const run = await runCli(["user", "token-revoke", "55", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
      script: [{ status: 204 }],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "DELETE",
      route: "tokens/55/",
      tag: "security",
    });
  });

  it("serializes inventory source variables and security-gates credentials", async () => {
    const run = await runCli([
      "inventory", "source-create", "cloud", "--inventory", "2", "--source", "ec2",
      "--source-vars", "{\"regions\":[\"us-east-1\"]}", "--credential", "5", "--confirm",
    ], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
      script: [{ status: 201, body: { id: 9, name: "cloud" } }],
    });
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "inventory_sources/",
      body: {
        credential: 5,
        source_vars: "{\"regions\":[\"us-east-1\"]}",
      },
      tag: "security",
    });

    const invalidMove = await runCli(["inventory", "source-edit", "9", "--inventory", "3"]);
    expect(invalidMove.exitCode).toBe(2);
    expect(invalidMove.transport.requests).toHaveLength(0);
  });

  it("accepts the AWX bulk host deletion response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awx-axi-hosts-"));
    const hostsFile = join(directory, "hosts.json");
    writeFileSync(hostsFile, "[11,12]");
    try {
      const run = await runCli(["inventory", "host-bulk-delete", "--hosts-file", hostsFile, "--confirm"], {
        env: { AWX_AXI_ALLOW_DELETES: "1" },
        script: [{ status: 201, body: {} }],
      });
      expect(run.exitCode).toBe(0);
      expect(run.transport.requests[0]).toMatchObject({
        method: "POST",
        route: "bulk/host_delete/",
        body: { hosts: [11, 12] },
        tag: "delete",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fully redacts secret-bearing notification files in previews", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awx-axi-notification-"));
    const configurationFile = join(directory, "configuration.json");
    const messagesFile = join(directory, "messages.json");
    writeFileSync(configurationFile, JSON.stringify({ url: "https://hooks.example/secret", headers: { Authorization: "Bearer secret" } }));
    writeFileSync(messagesFile, JSON.stringify({ started: { body: "secret message" } }));
    chmodSync(configurationFile, 0o600);
    chmodSync(messagesFile, 0o600);
    try {
      const run = await runCli([
        "notification-template", "create", "hook", "--organization", "1", "--notification-type", "webhook",
        "--configuration-file", configurationFile, "--messages-file", messagesFile,
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).not.toContain("hooks.example");
      expect(run.stdout).not.toContain("Bearer secret");
      expect(run.stdout).not.toContain("secret message");
      expect(run.stdout).toContain("***");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("security-gates secret-bearing notification writes and sensitive copies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awx-axi-security-"));
    const configurationFile = join(directory, "configuration.json");
    const messagesFile = join(directory, "messages.json");
    writeFileSync(configurationFile, JSON.stringify({ token: "secret" }));
    writeFileSync(messagesFile, JSON.stringify({ started: { body: "secret" } }));
    chmodSync(configurationFile, 0o600);
    chmodSync(messagesFile, 0o600);
    try {
      const create = await runCli([
        "notification-template", "create", "hook", "--organization", "1", "--notification-type", "webhook",
        "--configuration-file", configurationFile, "--confirm",
      ], {
        env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
        script: [{ status: 201, body: { id: 7, name: "hook" } }],
      });
      expect(create.transport.requests[0]).toMatchObject({ tag: "security" });

      const edit = await runCli([
        "notification-template", "edit", "7", "--messages-file", messagesFile, "--confirm",
      ], {
        env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
        script: [{ status: 200, body: { id: 7, name: "hook" } }],
      });
      expect(edit.transport.requests[0]).toMatchObject({ tag: "security" });

      for (const [domain, route] of [
        ["notification-template", "notification_templates/7/copy/"],
        ["execution-environment", "execution_environments/7/copy/"],
        ["project", "projects/7/copy/"],
      ] as const) {
        const copy = await runCli([domain, "copy", "7", "--confirm"], {
          env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
          script: [{ status: 201, body: { id: 8, name: "copy" } }],
        });
        expect(copy.transport.requests[0]).toMatchObject({ method: "POST", route, tag: "security" });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("security-gates credential-bearing execution environments", async () => {
    const run = await runCli([
      "execution-environment", "edit", "4", "--credential", "5", "--confirm",
    ], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
      script: [{ status: 200, body: { id: 4, name: "base" } }],
    });
    expect(run.transport.requests[0]).toMatchObject({
      method: "PATCH",
      route: "execution_environments/4/",
      body: { credential: 5 },
      tag: "security",
    });
  });

  it("manages organization membership and instance groups", async () => {
    const cases = [
      { command: "user-add", flag: "user", route: "users", tag: "security", body: { id: 8 } },
      { command: "user-remove", flag: "user", route: "users", tag: "security", body: { id: 8, disassociate: true } },
      { command: "admin-add", flag: "user", route: "admins", tag: "security", body: { id: 8 } },
      { command: "admin-remove", flag: "user", route: "admins", tag: "security", body: { id: 8, disassociate: true } },
      { command: "instance-group-add", flag: "instance-group", route: "instance_groups", tag: "config", body: { id: 6 } },
      { command: "instance-group-remove", flag: "instance-group", route: "instance_groups", tag: "config", body: { id: 6, disassociate: true } },
    ] as const;
    for (const testCase of cases) {
      const id = testCase.flag === "user" ? "8" : "6";
      const gate = testCase.tag === "security" ? "AWX_AXI_ALLOW_SECURITY_WRITES" : "AWX_AXI_ALLOW_CONFIG_WRITES";
      const run = await runCli(["organization", testCase.command, "10", `--${testCase.flag}`, id, "--confirm"], {
        env: { [gate]: "1" },
        script: [{ status: 204 }],
      });
      expect(run.transport.requests[0]).toMatchObject({
        method: "POST",
        route: `organizations/10/${testCase.route}/`,
        body: testCase.body,
        tag: testCase.tag,
      });
    }
  });

  it("manages team users and workflow template parity", async () => {
    const team = await runCli(["team", "user-add", "4", "--user", "8", "--confirm"], {
      env: { AWX_AXI_ALLOW_SECURITY_WRITES: "1" },
      script: [{ status: 204 }],
    });
    expect(team.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "teams/4/users/",
      body: { id: 8 },
      tag: "security",
    });

    const label = await runCli(["workflow", "label-remove", "30", "--label", "7", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      script: [{ status: 204 }],
    });
    expect(label.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "workflow_job_templates/30/labels/",
      body: { id: 7, disassociate: true },
      tag: "config",
    });

    const copy = await runCli(["workflow", "copy", "30", "--name", "copy", "--confirm"], {
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      script: [{ status: 201, body: { id: 31, name: "copy" } }],
    });
    expect(copy.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "workflow_job_templates/30/copy/",
      body: { name: "copy" },
      tag: "config",
    });
  });

  it("lists object roles for credentials, templates, and workflows", async () => {
    const cases = [
      ["credential", "credentials/5/object_roles/"],
      ["template", "job_templates/5/object_roles/"],
      ["workflow", "workflow_job_templates/5/object_roles/"],
    ] as const;
    for (const [domain, route] of cases) {
      const run = await runCli([domain, "object-roles", "5"], {
        script: [{
          status: 200,
          body: {
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 9, name: "Admin", description: "Can manage", type: "role" }],
          },
        }],
      });
      expect(run.exitCode).toBe(0);
      expect(run.transport.requests[0]).toMatchObject({ method: "GET", route });
      expect(run.stdout).toContain("Admin");
    }
  });

  it("rejects workflow node names before issuing requests", async () => {
    for (const argv of [
      ["workflow", "node-edit", "deploy", "--limit", "web"],
      ["workflow", "node-link", "2", "--on", "success", "--to", "deploy"],
      ["workflow", "node-add-approval", "deploy", "--name", "approve"],
    ]) {
      const run = await runCli(argv);
      expect(run.exitCode).toBe(2);
      expect(run.transport.requests).toHaveLength(0);
    }
  });

  it("validates new integer fields before constructing requests", async () => {
    for (const argv of [
      ["organization", "create", "bad", "--max-hosts", "many"],
      ["workflow", "node-edit", "4", "--verbosity", "6"],
      ["workflow", "node-add-approval", "4", "--name", "approve", "--timeout", "later"],
      ["workflow", "node-delete", "1e3"],
      ["workflow", "node-delete", "0x10"],
      ["workflow", "node-delete", " 4"],
    ]) {
      const run = await runCli(argv);
      expect(run.exitCode).toBe(2);
      expect(run.transport.requests).toHaveLength(0);
    }
  });

  it("executes every added command through a dry-run route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awx-axi-management-"));
    const hostsFile = join(directory, "hosts.json");
    writeFileSync(hostsFile, "[{\"name\":\"web-1\"}]");
    const cases: readonly [string[], string][] = [
      [["credential", "copy", "1"], "POST credentials/1/copy/"],
      [["execution-environment", "create", "ee", "--image", "example/ee"], "POST execution_environments/"],
      [["execution-environment", "edit", "1", "--image", "example/ee2"], "PATCH execution_environments/1/"],
      [["execution-environment", "copy", "1"], "POST execution_environments/1/copy/"],
      [["execution-environment", "delete", "1"], "DELETE execution_environments/1/"],
      [["inventory", "group-create", "group", "--inventory", "1"], "POST inventories/1/groups/"],
      [["inventory", "group-edit", "2", "--name", "group2"], "PATCH groups/2/"],
      [["inventory", "group-delete", "2"], "DELETE groups/2/"],
      [["inventory", "group-add-host", "2", "--host", "3"], "POST groups/2/hosts/"],
      [["inventory", "group-remove-host", "2", "--host", "3"], "POST groups/2/hosts/"],
      [["inventory", "group-add-child", "2", "--child", "4"], "POST groups/2/children/"],
      [["inventory", "group-remove-child", "2", "--child", "4"], "POST groups/2/children/"],
      [["inventory", "source-create", "source", "--inventory", "1", "--source", "ec2"], "POST inventory_sources/"],
      [["inventory", "source-edit", "5", "--name", "source2"], "PATCH inventory_sources/5/"],
      [["inventory", "source-delete", "5"], "DELETE inventory_sources/5/"],
      [["inventory", "source-credential-add", "5", "--credential", "6"], "POST inventory_sources/5/credentials/"],
      [["inventory", "source-credential-remove", "5", "--credential", "6"], "POST inventory_sources/5/credentials/"],
      [["inventory", "source-notification-add", "5", "--event", "success", "--notification-template", "7"], "POST inventory_sources/5/notification_templates_success/"],
      [["inventory", "source-notification-remove", "5", "--event", "success", "--notification-template", "7"], "POST inventory_sources/5/notification_templates_success/"],
      [["inventory", "host-bulk-create", "--inventory", "1", "--hosts-file", hostsFile], "POST bulk/host_create/"],
      [["notification-template", "edit", "7", "--name", "mail2"], "PATCH notification_templates/7/"],
      [["notification-template", "copy", "7"], "POST notification_templates/7/copy/"],
      [["notification-template", "delete", "7"], "DELETE notification_templates/7/"],
      [["organization", "team-remove", "1", "--team", "2"], "POST organizations/1/teams/"],
      [["organization", "execution-environment-add", "1", "--execution-environment", "2"], "POST organizations/1/execution_environments/"],
      [["organization", "execution-environment-remove", "1", "--execution-environment", "2"], "POST organizations/1/execution_environments/"],
      [["organization", "notification-template-add", "1", "--notification-template", "2"], "POST organizations/1/notification_templates/"],
      [["organization", "notification-template-remove", "1", "--notification-template", "2"], "POST organizations/1/notification_templates/"],
      [["organization", "galaxy-credential-add", "1", "--credential", "2"], "POST organizations/1/galaxy_credentials/"],
      [["organization", "galaxy-credential-remove", "1", "--credential", "2"], "POST organizations/1/galaxy_credentials/"],
      [["organization", "notification-add", "1", "--event", "success", "--notification-template", "2"], "POST organizations/1/notification_templates_success/"],
      [["organization", "notification-remove", "1", "--event", "success", "--notification-template", "2"], "POST organizations/1/notification_templates_success/"],
      [["project", "copy", "1"], "POST projects/1/copy/"],
      [["project", "notification-remove", "1", "--event", "success", "--notification-template", "2"], "POST projects/1/notification_templates_success/"],
      [["schedule", "credential-remove", "1", "--credential", "2"], "POST schedules/1/credentials/"],
      [["schedule", "label-add", "1", "--label", "2"], "POST schedules/1/labels/"],
      [["schedule", "label-remove", "1", "--label", "2"], "POST schedules/1/labels/"],
      [["schedule", "instance-group-add", "1", "--instance-group", "2"], "POST schedules/1/instance_groups/"],
      [["schedule", "instance-group-remove", "1", "--instance-group", "2"], "POST schedules/1/instance_groups/"],
      [["template", "credential-remove", "1", "--credential", "2"], "POST job_templates/1/credentials/"],
      [["template", "instance-group-add", "1", "--instance-group", "2"], "POST job_templates/1/instance_groups/"],
      [["template", "instance-group-remove", "1", "--instance-group", "2"], "POST job_templates/1/instance_groups/"],
      [["template", "label-add", "1", "--label", "2"], "POST job_templates/1/labels/"],
      [["template", "label-remove", "1", "--label", "2"], "POST job_templates/1/labels/"],
      [["template", "notification-add", "1", "--event", "success", "--notification-template", "2"], "POST job_templates/1/notification_templates_success/"],
      [["template", "notification-remove", "1", "--event", "success", "--notification-template", "2"], "POST job_templates/1/notification_templates_success/"],
      [["team", "user-remove", "1", "--user", "2"], "POST teams/1/users/"],
      [["workflow", "node-edit", "2", "--limit", "web"], "PATCH workflow_job_template_nodes/2/"],
      [["workflow", "node-delete", "2"], "DELETE workflow_job_template_nodes/2/"],
      [["workflow", "node-link", "2", "--on", "success", "--to", "3"], "POST workflow_job_template_nodes/2/success_nodes/"],
      [["workflow", "node-unlink", "2", "--on", "success", "--to", "3"], "POST workflow_job_template_nodes/2/success_nodes/"],
      [["workflow", "node-credential-add", "2", "--credential", "3"], "POST workflow_job_template_nodes/2/credentials/"],
      [["workflow", "node-credential-remove", "2", "--credential", "3"], "POST workflow_job_template_nodes/2/credentials/"],
      [["workflow", "node-label-add", "2", "--label", "3"], "POST workflow_job_template_nodes/2/labels/"],
      [["workflow", "node-label-remove", "2", "--label", "3"], "POST workflow_job_template_nodes/2/labels/"],
      [["workflow", "node-instance-group-add", "2", "--instance-group", "3"], "POST workflow_job_template_nodes/2/instance_groups/"],
      [["workflow", "node-instance-group-remove", "2", "--instance-group", "3"], "POST workflow_job_template_nodes/2/instance_groups/"],
      [["workflow", "node-add-approval", "2", "--name", "approve"], "POST workflow_job_template_nodes/2/create_approval_template/"],
      [["workflow", "notification-add", "1", "--event", "success", "--notification-template", "2"], "POST workflow_job_templates/1/notification_templates_success/"],
      [["workflow", "notification-remove", "1", "--event", "success", "--notification-template", "2"], "POST workflow_job_templates/1/notification_templates_success/"],
      [["workflow", "label-add", "1", "--label", "2"], "POST workflow_job_templates/1/labels/"],
    ];
    try {
      for (const [argv, route] of cases) {
        const run = await runCli(argv);
        expect(run.exitCode, argv.join(" ")).toBe(0);
        expect(run.transport.requests, argv.join(" ")).toHaveLength(0);
        expect(run.stdout, argv.join(" ")).toContain(route);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
