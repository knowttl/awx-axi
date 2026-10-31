import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RecordedExchange } from "../src/core/transport.js";
import { runCli } from "./support/run.js";

const guide = readFileSync(new URL("../docs/agent-guide.md", import.meta.url), "utf8");
const examples: { command: string; script: (string | RecordedExchange)[]; output: string }[] = [
  { command: "host list --search web --inventory 11 --limit 5", script: ["host-list"], output: "hosts[" },
  { command: "host show web-01.example.com", script: ["host-name-one", "host-detail", "host-groups", "host-variable-data", "host-ansible-facts"], output: "ansible_distribution: Debian" },
  { command: "host inspect 501,601", script: ["host-detail", "host-groups", "host-variable-data", "host-ansible-facts", "host-detail", "host-groups", "host-variable-data", "host-ansible-facts"], output: "complete: true" },
  { command: "group show 31", script: ["group-detail", "group-hosts", "group-children", "group-variable-data"], output: "total_children: 1" },
  { command: "inventory hosts 11 --facts --limit 5", script: ["inventory-hosts", "inventory-host-facts"], output: "2 keys" },
  { command: "job list --type all --failed --since 2h --limit 5 --fields type,launched_by,template", script: ["unified-jobs-page-1"], output: "launched_by,template" },
  { command: "job show 1839 --type job", script: ["job-detail-terminal", "job-host-summaries", "job-events-page", "stdout-ranged"], output: "failed_tasks[" },
  { command: "job stdout 1839 --type job --tail 50", script: ["stdout-ranged"], output: "PLAY [all]" },
  { command: "job events 1839 --failed --limit 5", script: ["job-events-page"], output: "events[" },
  { command: "job hosts 1839 --limit 5", script: ["job-host-summaries"], output: "db-01" },
  { command: "job watch 1839 --type job --timeout 60 --interval 5", script: [
    { status: 200, body: { id: 1839, status: "running" } },
    { status: 200, body: { id: 1839, status: "successful" } },
  ], output: "status: successful" },
  { command: "workflow nodes 1840 --limit 5", script: ["workflow-nodes"], output: "nodes[" },
  { command: "activity-stream list --job 1839 --limit 5", script: ["activity-stream-list"], output: "activity_stream[" },
  { command: "activity-stream show 9001", script: ["activity-stream-show"], output: "changes:" },
];

describe("investigation guide", () => {
  it("covers every executable example with an offline scenario", () => {
    expect(guide.match(/^awx-axi .+$/gm)).toEqual(examples.map(({ command }) => `awx-axi ${command}`));
  });

  it.each(examples)("runs $command read-only without a help lookup", async ({ command, script, output }) => {
    const run = await runCli(command.split(" "), { script, env: { AWX_AXI_READ_ONLY: "1" } });

    expect(run.exitCode, run.stdout).toBe(0);
    expect(run.stdout).toContain(output);
    expect(run.transport.requests.length).toBeGreaterThan(0);
    expect(run.transport.requests.every(({ method }) => method === "GET")).toBe(true);
  });
});
