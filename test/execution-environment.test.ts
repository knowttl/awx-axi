import { describe, expect, it } from "vitest";

import { runCli } from "./support/run.js";

describe("execution-environment list (design.md §7.10?)", () => {
  it("lists environments with filters and paginates", async () => {
    const run = await runCli(
      [
        "execution-environment",
        "list",
        "--search",
        "container",
        "--organization",
        "1",
        "--type",
        "container",
        "--limit",
        "3",
      ],
      {
        script: [
          "execution-environment-list-page-1",
          "execution-environment-list-page-2",
        ],
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "execution_environments/",
      query: {
        search: "container",
        organization: 1,
        type: "container",
        page_size: 3,
      },
    });
    expect(run.transport.requests[1]?.route).toBe("/api/v2/execution_environments/");
    expect(run.stdout).toContain(
      "execution_environments[3]{id,name,type,organization,image}:",
    );
    expect(run.stdout).toContain("11,base-alpine,container,1 (Operations)");
  });

  it("supports organization lookup for show via id and shows unified templates", async () => {
    const run = await runCli(["execution-environment", "show", "12"], {
      script: ["execution-environment-show", "execution-environment-unified-job-templates"],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "execution_environments/12/",
    });
    expect(run.transport.requests[1]).toMatchObject({
      route: "execution_environments/12/unified_job_templates/",
    });
    expect(run.stdout).toContain("id: 12");
    expect(run.stdout).toContain("name: Standard controller image");
    expect(run.stdout).toContain("managed: managed");
    expect(run.stdout).toContain("unified_job_templates[2]{id,name,type}:");
    expect(run.stdout).toContain("11,Deploy web tier");
    expect(run.stdout).toContain("Run `awx-axi template list --search <s>`");
  });

  it("resolves name for show and fetches related templates", async () => {
    const run = await runCli(["execution-environment", "show", "Standard controller image"], {
      script: [
        "execution-environment-name-one",
        "execution-environment-show",
        "execution-environment-unified-job-templates",
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "GET",
      route: "execution_environments/",
      query: { name: "Standard controller image" },
    });
    expect(run.stdout).toContain("name: Standard controller image");
    expect(run.stdout).toContain("id: 12");
  });

  it("rejects non-positive --organization", async () => {
    const run = await runCli(
      ["execution-environment", "list", "--organization", "0"],
      { script: [] },
    );

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
  });
});
