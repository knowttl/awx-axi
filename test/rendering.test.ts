import { runAxiCli } from "axi-sdk-js";
import { describe, expect, it } from "vitest";

/**
 * The two rendering paths the CLI loop offers (design.md §8, §8.4).
 *
 * The verbatim string path is the only sanctioned seam for the raw log region
 * `job stdout` needs, so it is asserted here rather than assumed: the design
 * described this mechanism incorrectly until it was verified by import.
 */
async function render(output: string | Record<string, unknown>): Promise<string> {
  const chunks: string[] = [];

  await runAxiCli({
    argv: ["render"],
    stdout: {
      write: (chunk) => {
        chunks.push(chunk);
      },
    },
    description: "test",
    topLevelHelp: "",
    commands: { render: () => output },
    home: () => ({}),
  });

  return chunks.join("");
}

describe("handler output rendering", () => {
  it("writes a returned string through verbatim", async () => {
    const raw = 'PLAY [db] ***\nfatal: [db-02]: FAILED! => {"changed": false}\n';

    expect(await render(raw)).toBe(`${raw}\n`);
  });

  it("TOON-encodes a returned object", async () => {
    const encoded = await render({ job: { id: 1839, status: "failed" } });

    expect(encoded).toBe("job:\n  id: 1839\n  status: failed\n");
  });
});
