import type { Renderable } from "../core/registry.js";

/**
 * Provisional home view. The real §8.1 home view - what is running, what needs
 * a decision, what broke - is a later task, and inventing its output here would
 * be wrong. `runAxiCli` requires a home handler, so this one says plainly that
 * nothing is registered yet.
 *
 * The SDK merges the `bin:` and `description:` header into this output.
 */
export function homeCommand(): Renderable {
  return {
    awx: "scaffold build: no commands are registered yet",
    help: ["Run `awx-axi --help` to see what this build provides"],
  };
}
