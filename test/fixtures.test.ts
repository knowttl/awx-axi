import { describe, expect, it } from "vitest";

import { fixtureNames, loadFixture } from "./support/fixtures.js";

/**
 * Every fixture cites the 24.6.1 source it was derived from (design.md §11.2),
 * so it can be re-verified against the tag rather than trusted. Fixtures are
 * derived from the source, never recorded from the captain's instance (§6.5).
 */
describe("the fixture corpus", () => {
  const names = fixtureNames();

  it("has fixtures", () => {
    expect(names.length).toBeGreaterThan(15);
  });

  it.each(names)("%s cites a source file and line", (file) => {
    const fixture = loadFixture(file.replace(/\.json$/, ""));

    expect(fixture.$tag).toBe("24.6.1");
    expect(fixture.$source).toMatch(/^(awx|docs)\/[\w./_-]+(:\d+(-\d+)?)?$/);
    expect(fixture.$note.length).toBeGreaterThan(40);
    expect(typeof fixture.status).toBe("number");
  });
});
