import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

/** A job_templates/<id>/ detail response with the given ask_*_on_launch flags. */
function templateDetail(id: number, prompts: Record<string, boolean>) {
  return { status: 200, body: { id, name: `template-${id}`, ...prompts } };
}

describe("schedule list (design.md §7.10?)", () => {
  it("lists schedules with template and enabled filters across pages", async () => {
    const run = await runCli([
      "schedule",
      "list",
      "--template",
      "77",
      "--enabled",
      "--limit",
      "3",
    ], {
      script: ["schedule-list-page-1", "schedule-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "schedules/",
      query: {
        unified_job_template: 77,
        enabled: true,
        page_size: 3,
      },
    });
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "/api/v2/schedules/",
    });
    expect(run.stdout).toContain("schedules[3]{id,name,template,enabled,next_run}:");
    expect(run.stdout).toContain("201,nightly-security-scan,77 (Security scan template),enabled");
    expect(run.stdout).toContain("Run `awx-axi schedule show <id|name>` to inspect schedule detail and timing");
  });

  it("supports search and disabled filters", async () => {
    const run = await runCli([
      "schedule",
      "list",
      "--search",
      "compliance",
      "--disabled",
    ], {
      script: ["schedule-list-page-1", "schedule-list-page-2"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]?.query).toMatchObject({
      search: "compliance",
      enabled: false,
    });
  });

  it("shows schedule detail with preview and template resolution", async () => {
    const run = await runCli(["schedule", "show", "Nightly security scan"], {
      script: ["schedule-name-one", "schedule-show"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "schedules/",
      query: { name: "Nightly security scan" },
    });
    expect(run.transport.requests[1]).toMatchObject({
      route: "schedules/201/",
    });
    expect(run.stdout).toContain("id: 201");
    expect(run.stdout).toContain("template: 77 (Security scan template)");
    expect(run.stdout).toContain('preview: "zone UTC:');
    expect(run.stdout).toContain("awx-axi schedule list --template 77");
  });

  it("rejects a non-positive --limit", async () => {
    const run = await runCli(["schedule", "list", "--limit", "0"], {
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
  });

  it("schedule create and edit support dry-run and --confirm", async () => {
    const dryCreate = await runCli(["schedule", "create", "Nightly Backup", "--template", "12"], { script: [] });
    expect(dryCreate.exitCode).toBe(0);
    expect(dryCreate.stdout).toContain("dry_run:");
    expect(dryCreate.stdout).toContain("would_send: POST schedules/");

    const liveCreate = await runCli(["schedule", "create", "Nightly Backup", "--template", "12", "--confirm"], {
      script: [{ status: 201, body: { id: 30, name: "Nightly Backup", enabled: true } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveCreate.exitCode).toBe(0);
    expect(liveCreate.stdout).toContain("id: 30");

    const dryEdit = await runCli(["schedule", "edit", "30", "--disabled"], { script: [] });
    expect(dryEdit.exitCode).toBe(0);
    expect(dryEdit.stdout).toContain("would_send: PATCH schedules/30/");

    const liveEdit = await runCli(["schedule", "edit", "30", "--disabled", "--confirm"], {
      script: [{ status: 200, body: { id: 30, name: "Nightly Backup", enabled: false } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });
    expect(liveEdit.exitCode).toBe(0);
    expect(liveEdit.stdout).toContain("id: 30");
  });

  it("schedule delete supports dry-run and --confirm", async () => {
    const dryDelete = await runCli(["schedule", "delete", "201"], { script: [] });
    expect(dryDelete.exitCode).toBe(0);
    expect(dryDelete.stdout).toContain("dry_run:");
    expect(dryDelete.stdout).toContain("would_send: DELETE schedules/201/");

    const liveDelete = await runCli(["schedule", "delete", "201", "--confirm"], {
      script: [{ status: 204 }],
      env: { AWX_AXI_ALLOW_DELETES: "1" },
    });
    expect(liveDelete.exitCode).toBe(0);
    expect(liveDelete.stdout).toContain("status: deleted");
    expect(liveDelete.transport.requests[0]).toMatchObject({
      method: "DELETE",
      route: "schedules/201/",
    });
  });

  it("schedule create sends inventory, limit, and extra-vars once the template allows them", async () => {
    const run = await runCli(
      [
        "schedule",
        "create",
        "Nightly Deploy",
        "--template",
        "57",
        "--inventory",
        "9",
        "--limit",
        "webservers",
        "--extra-vars",
        '{"env":"prod"}',
        "--confirm",
      ],
      {
        script: [
          templateDetail(57, {
            ask_inventory_on_launch: true,
            ask_limit_on_launch: true,
            ask_variables_on_launch: true,
          }),
          { status: 201, body: { id: 40, name: "Nightly Deploy", enabled: true } },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({ method: "GET", route: "job_templates/57/" });
    expect(run.transport.requests[1]).toMatchObject({
      method: "POST",
      route: "schedules/",
      body: {
        name: "Nightly Deploy",
        unified_job_template: 57,
        inventory: 9,
        limit: "webservers",
        extra_data: { env: "prod" },
      },
    });
    expect(run.stdout).toContain("id: 40");
  });

  it("resolves an --inventory name to exactly one id with one extra request", async () => {
    const run = await runCli(
      [
        "schedule",
        "create",
        "Nightly Deploy",
        "--template",
        "57",
        "--inventory",
        "Production",
        "--confirm",
      ],
      {
        script: [
          templateDetail(57, { ask_inventory_on_launch: true }),
          { status: 200, body: { count: 1, results: [{ id: 9, name: "Production" }] } },
          { status: 201, body: { id: 41, name: "Nightly Deploy" } },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[1]).toMatchObject({
      method: "GET",
      route: "inventories/",
      query: { name: "Production" },
    });
    expect(run.transport.requests[2]).toMatchObject({
      method: "POST",
      body: { inventory: 9 },
    });
  });

  it("fails unambiguously with shell-safe help when an --inventory name is ambiguous", async () => {
    const scheduleName = "--nightly-$HOME's-$(deploy)";
    const run = await runCli(
      ["schedule", "create", `--name=${scheduleName}`, "--template", "57", "--inventory", "Prod", "--confirm"],
      {
        script: [
          templateDetail(57, { ask_inventory_on_launch: true }),
          {
            status: 200,
            body: {
              count: 2,
              results: [
                { id: 9, name: "Prod" },
                { id: 10, name: "Prod" },
              ],
            },
          },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(run.stdout).toContain(
      `awx-axi schedule create --name='--nightly-$HOME'"'"'s-$(deploy)' --template 57 --inventory 9`,
    );
    expect(run.stdout).not.toContain("awx-axi schedule create 9");
  });

  it("includes the schedule id in ambiguous --inventory help for edit", async () => {
    const run = await runCli(
      ["schedule", "edit", "30", "--inventory", "Prod"],
      {
        script: [
          {
            status: 200,
            body: { id: 30, unified_job_template: 57 },
          },
          templateDetail(57, { ask_inventory_on_launch: true }),
          {
            status: 200,
            body: {
              count: 2,
              results: [
                { id: 9, name: "Prod" },
                { id: 10, name: "Prod" },
              ],
            },
          },
        ],
      },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: AMBIGUOUS_NAME");
    expect(run.stdout).toContain("awx-axi schedule edit 30 --inventory 9");
    expect(run.stdout).not.toContain("awx-axi schedule edit 9");
  });

  it("rejects each new prompt flag when its template setting is disabled", async () => {
    const cases: readonly { flag: string; value: string; promptKey: string }[] = [
      { flag: "--inventory", value: "9", promptKey: "ask_inventory_on_launch" },
      { flag: "--limit", value: "webservers", promptKey: "ask_limit_on_launch" },
      { flag: "--extra-vars", value: '{"env":"prod"}', promptKey: "ask_variables_on_launch" },
      { flag: "--job-tags", value: "deploy", promptKey: "ask_tags_on_launch" },
      { flag: "--skip-tags", value: "slow", promptKey: "ask_skip_tags_on_launch" },
    ];

    for (const testCase of cases) {
      const run = await runCli(
        ["schedule", "create", "Nightly Deploy", "--template", "57", testCase.flag, testCase.value],
        { script: [templateDetail(57, {})] },
      );

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("code: LAUNCH_WOULD_IGNORE_INPUT");
      expect(run.stdout).toContain(testCase.flag);
      expect(run.stdout).toContain(testCase.promptKey);
    }
  });

  it("rejects all disallowed prompt flags in one error naming every field", async () => {
    const run = await runCli(
      [
        "schedule",
        "create",
        "Nightly Deploy",
        "--template",
        "57",
        "--inventory",
        "9",
        "--limit",
        "webservers",
        "--job-tags",
        "deploy",
      ],
      { script: [templateDetail(57, {})] },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("--inventory");
    expect(run.stdout).toContain("--limit");
    expect(run.stdout).toContain("--job-tags");
  });

  it("rejects malformed --extra-vars JSON before any write", async () => {
    const run = await runCli(
      ["schedule", "create", "Nightly Deploy", "--template", "57", "--extra-vars", "not-json"],
      { script: [templateDetail(57, { ask_variables_on_launch: true })] },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.transport.requests).toHaveLength(1);
  });

  it("rejects an --extra-vars @file reference that cannot be read", async () => {
    const run = await runCli(
      ["schedule", "create", "Nightly Deploy", "--template", "57", "--extra-vars", "@/nonexistent/vars.json"],
      { script: [templateDetail(57, { ask_variables_on_launch: true })] },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("could not be read");
  });

  it("reads --extra-vars from an @file JSON object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awx-axi-schedule-"));
    const filePath = join(dir, "vars.json");
    writeFileSync(filePath, JSON.stringify({ region: "us-east-1" }));

    try {
      const run = await runCli(
        [
          "schedule",
          "create",
          "Nightly Deploy",
          "--template",
          "57",
          "--extra-vars",
          `@${filePath}`,
          "--confirm",
        ],
        {
          script: [
            templateDetail(57, { ask_variables_on_launch: true }),
            { status: 201, body: { id: 42, name: "Nightly Deploy" } },
          ],
          env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
        },
      );

      expect(run.exitCode).toBe(0);
      expect(run.transport.requests[1]).toMatchObject({
        body: { extra_data: { region: "us-east-1" } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires --template to validate prompt flags on create", async () => {
    const run = await runCli(
      ["schedule", "create", "Nightly Deploy", "--inventory", "9"],
      { script: [] },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("needs --template");
  });

  it("schedule edit derives the job template from the existing schedule when --template is omitted", async () => {
    const run = await runCli(
      ["schedule", "edit", "30", "--limit", "webservers", "--confirm"],
      {
        script: [
          {
            status: 200,
            body: {
              id: 30,
              name: "Nightly Backup",
              summary_fields: { unified_job_template: { id: 57, name: "Deploy" } },
            },
          },
          templateDetail(57, { ask_limit_on_launch: true }),
          { status: 200, body: { id: 30, name: "Nightly Backup", enabled: true } },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({ method: "GET", route: "schedules/30/" });
    expect(run.transport.requests[1]).toMatchObject({ method: "GET", route: "job_templates/57/" });
    expect(run.transport.requests[2]).toMatchObject({
      method: "PATCH",
      route: "schedules/30/",
      body: { limit: "webservers" },
    });
  });

  it("schedule edit validates against the newly supplied --template, not the existing one", async () => {
    const run = await runCli(
      ["schedule", "edit", "30", "--template", "58", "--limit", "webservers", "--confirm"],
      {
        script: [
          templateDetail(58, { ask_limit_on_launch: true }),
          { status: 200, body: { id: 30, name: "Nightly Backup" } },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({ method: "GET", route: "job_templates/58/" });
    expect(run.transport.requests).toHaveLength(2);
  });

  it("issues no extra requests when none of the new prompt flags are supplied", async () => {
    const run = await runCli(["schedule", "edit", "30", "--disabled", "--confirm"], {
      script: [{ status: 200, body: { id: 30, name: "Nightly Backup", enabled: false } }],
      env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toHaveLength(1);
    expect(run.transport.requests[0]).toMatchObject({ method: "PATCH", route: "schedules/30/" });
  });

  it("refuses to write without AWX_AXI_ALLOW_CONFIG_WRITES even after prompt validation passes", async () => {
    const run = await runCli(
      ["schedule", "create", "Nightly Deploy", "--template", "57", "--inventory", "9", "--confirm"],
      { script: [templateDetail(57, { ask_inventory_on_launch: true })], env: {} },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: CONFIG_WRITES_DISABLED");
  });

  it("sanitizes echoed extra-vars in schedule create controller errors", async () => {
    const run = await runCli(
      [
        "schedule",
        "create",
        "Nightly Deploy",
        "--template",
        "57",
        "--extra-vars",
        '{"db_password":"s3cr3t-value","nested":{"token":"nested-secret"}}',
        "--confirm",
      ],
      {
        script: [
          templateDetail(57, { ask_variables_on_launch: true }),
          {
            status: 400,
            body: {
              extra_data: ["db_password=s3cr3t-value is invalid"],
              reason: ["nested-secret was rejected"],
            },
          },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("extra_data: ***");
    expect(run.stdout).toContain("reason: *** was rejected");
    expect(run.stdout).not.toContain("s3cr3t-value");
    expect(run.stdout).not.toContain("nested-secret");
  });

  it("sanitizes echoed nested extra-vars in schedule edit controller errors", async () => {
    const run = await runCli(
      [
        "schedule",
        "edit",
        "30",
        "--template",
        "57",
        "--extra-vars",
        '{"nested":{"token":"nested-secret"}}',
        "--confirm",
      ],
      {
        script: [
          templateDetail(57, { ask_variables_on_launch: true }),
          { status: 403, body: { detail: "nested-secret is not permitted" } },
        ],
        env: { AWX_AXI_ALLOW_CONFIG_WRITES: "1" },
      },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: FORBIDDEN");
    expect(run.stdout).toContain("*** is not permitted");
    expect(run.stdout).toContain("awx-axi auth status");
    expect(run.stdout).not.toContain("nested-secret");
  });

  it("redacts secret-looking extra-vars keys in the dry-run preview and never prints them raw", async () => {
    const run = await runCli(
      [
        "schedule",
        "create",
        "Nightly Deploy",
        "--template",
        "57",
        "--extra-vars",
        '{"db_password":"s3cr3t-value","env":"prod"}',
      ],
      { script: [templateDetail(57, { ask_variables_on_launch: true })] },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dry_run:");
    expect(run.stdout).not.toContain("s3cr3t-value");
    expect(run.stdout).toContain("env: prod");
  });
});
