import { describe, expect, it } from "vitest";

import {
  assertNoMutations,
  buildLiveEnv,
  runLiveCli,
} from "./support/live.js";

let liveEnv: Awaited<ReturnType<typeof buildLiveEnv>> | undefined;
try {
  liveEnv = buildLiveEnv();
} catch {
  liveEnv = undefined;
}

const suite = liveEnv === undefined ? describe.skip : describe;

const READ_ONLY_CASES: { name: string; command: string[]; marker: string }[] = [
  { name: "job list", command: ["job", "list", "--limit", "1"], marker: "jobs[" },
  {
    name: "template list",
    command: ["template", "list", "--limit", "1"],
    marker: "job_templates[",
  },
  {
    name: "workflow list",
    command: ["workflow", "list", "--limit", "1"],
    marker: "workflow_job_templates",
  },
  {
    name: "approval list",
    command: ["approval", "list", "--limit", "1"],
    marker: "approvals",
  },
  {
    name: "project list",
    command: ["project", "list", "--limit", "1"],
    marker: "projects[",
  },
  {
    name: "inventory list",
    command: ["inventory", "list", "--search", "site", "--limit", "1"],
    marker: "inventories[",
  },
  {
    name: "execution-environment list",
    command: [
      "execution-environment",
      "list",
      "--search",
      "container",
      "--limit",
      "1",
    ],
    marker: "execution_environments[",
  },
  {
    name: "schedule list",
    command: ["schedule", "list", "--search", "nightly", "--limit", "1"],
    marker: "schedules[",
  },
];

suite("live read-only smoke checks (design.md §11.3)", () => {
  for (const { name, command, marker } of READ_ONLY_CASES) {
    it(`reads ${name} without sending mutations`, async () => {
      if (liveEnv === undefined) {
        throw new Error("live suite is not opted-in");
      }

      const run = await runLiveCli(command, { env: liveEnv });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("count:");
      expect(run.stdout).toContain(marker);
      assertNoMutations(run.calls);
      expect(run.calls.length).toBeGreaterThan(0);
    });
  }
});
