import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createSkillMarkdown,
  HERMES_CATEGORY,
  HERMES_TAGS,
  SKILL_AUTHOR,
  SKILL_DESCRIPTION,
} from "../src/skill.js";

describe("skill definition (design.md §13)", () => {
  it("exports the required Hermes skill metadata constants", () => {
    expect(typeof SKILL_AUTHOR).toBe("string");
    expect(SKILL_AUTHOR).toBe("Kun Chen (kunchenguid)");

    expect(typeof SKILL_DESCRIPTION).toBe("string");
    expect(SKILL_DESCRIPTION.length).toBeGreaterThan(0);

    expect(HERMES_TAGS).toEqual([
      "awx",
      "ansible",
      "automation",
      "devops",
      "jobs",
      "workflows",
    ]);

    expect(HERMES_CATEGORY).toBe("devops");
  });

  it("generates markdown with correct YAML frontmatter and sections", () => {
    const markdown = createSkillMarkdown();

    expect(markdown).toContain("name: awx-axi");
    expect(markdown).toContain(`author: ${SKILL_AUTHOR}`);
    expect(markdown).toContain(`category: ${HERMES_CATEGORY}`);
    expect(markdown).toContain(
      "tags: [awx, ansible, automation, devops, jobs, workflows]",
    );
    expect(markdown).toContain("# awx-axi");
    expect(markdown).toContain("## When to use");
    expect(markdown).toContain("## Workflow");
    expect(markdown).toContain("## Commands");
    expect(markdown).toContain("## Tips");
  });

  it("contains notification and activity guidance", () => {
    const markdown = createSkillMarkdown();

    expect(markdown).toContain("schedule list");
    expect(markdown).toContain("execution-environment list");
    expect(markdown).toContain("organization list");
    expect(markdown).toContain("credential show <id|name>");
    expect(markdown).toContain("user show <id|name>");
    expect(markdown).toContain("system-job-template show <id|name>");
    expect(markdown).toContain("system-job notifications");
    expect(markdown).toMatch(/notification\s+list, show <id>/);
    expect(markdown).toMatch(/notification-template\s+list, show <id\|name>/);
    expect(markdown).toMatch(/activity-stream\s+list, show <id>/);
    expect(markdown).toContain("commands[19 total]");
  });

  it("matches the committed skills/awx-axi/SKILL.md file verbatim", () => {
    const skillFilePath = resolve(process.cwd(), "skills/awx-axi/SKILL.md");
    const committedContent = readFileSync(skillFilePath, "utf-8");

    expect(createSkillMarkdown()).toBe(committedContent);
  });
});
