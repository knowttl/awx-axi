import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackedFile = { path: string };
type PackResult = { filename: string; files: PackedFile[] };

const projectRoot = resolve(import.meta.dirname, "..");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

describe("the published package", () => {
  it("installs a working awx-axi executable", () => {
    const directory = mkdtempSync(join(tmpdir(), "awx-axi-package-"));

    try {
      const packed = JSON.parse(
        run("npm", ["pack", "--json", "--pack-destination", directory], projectRoot),
      ) as PackResult[];
      const [result] = packed;
      if (result === undefined) {
        throw new Error("npm pack returned no package");
      }
      expect(result.files.map((file) => file.path)).toEqual(
        expect.arrayContaining(["LICENSE", "dist/bin/awx-axi.js"]),
      );

      const tarball = join(directory, result.filename);
      run("npm", ["init", "--yes"], directory);
      run("npm", ["install", "--ignore-scripts", tarball], directory);

      const manifest = JSON.parse(
        readFileSync(join(directory, "node_modules/awx-axi/package.json"), "utf8"),
      ) as { bin: { "awx-axi": string }; repository: { url: string } };
      expect(manifest.repository.url).toBe("git+https://github.com/knowttl/awx-axi.git");
      expect(manifest.bin["awx-axi"]).toBe("dist/bin/awx-axi.js");

      const output = run(
        join(directory, "node_modules/.bin/awx-axi"),
        ["--help"],
        directory,
      );
      expect(output).toContain("description: Inspect and run AWX automation from the shell");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
