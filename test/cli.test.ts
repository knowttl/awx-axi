import { describe, expect, it } from "vitest";

import { DESCRIPTION, DOMAINS, main } from "../src/cli.js";

function capture(): { write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(""),
  };
}

describe("the CLI shell", () => {
  it("renders the top-level help for --help", async () => {
    const stdout = capture();

    await main({ argv: ["--help"], stdout, env: {} });

    expect(stdout.text()).toContain(`description: ${DESCRIPTION}`);
    expect(stdout.text()).toContain("awx-axi <command> [args] [flags]");
  });

  it("renders the version for --version", async () => {
    const stdout = capture();

    await main({ argv: ["--version"], stdout, env: {} });

    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("registers no domains yet", () => {
    expect(DOMAINS).toHaveLength(0);
  });
});
