import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLiveEnv, runLiveCli } from "./live/support/live.js";
import { fixtureFetch } from "./support/fixtures.js";

describe("live suite gate behavior", () => {
  let testHome: string;
  let isolatedEnv: { HOME: string; AWX_AXI_HOME: string; XDG_CONFIG_HOME: string };
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "awx-live-gate-test-"));
    isolatedEnv = { HOME: testHome, AWX_AXI_HOME: join(testHome, "legacy"), XDG_CONFIG_HOME: join(testHome, ".config") };
  });
  afterEach(() => { rmSync(testHome, { recursive: true, force: true }); });

  it("fails when live mode is not opt-in", () => {
    expect(() => buildLiveEnv({})).toThrowError(
      /AWX_AXI_LIVE=1 to run the live suite/,
    );
  });

  it("fails when controller config is incomplete", () => {
    expect(() =>
      buildLiveEnv({ AWX_AXI_LIVE: "1", AWX_AXI_ORIGIN: "https://awx.example.com" }),
    ).toThrowError(/must be set to run live checks/);

    expect(() =>
      buildLiveEnv({
        AWX_AXI_LIVE: "1",
        AWX_AXI_TOKEN: "test-token",
      }),
    ).toThrowError(/must be set to run live checks/);
  });

  it("enforces read-only mode for live runs", () => {
    const env = buildLiveEnv({
      AWX_AXI_LIVE: "1",
      AWX_AXI_ORIGIN: "https://awx.example.com",
      AWX_AXI_TOKEN: "test-token",
      AWX_AXI_READ_ONLY: "0",
      ...isolatedEnv,
    });

    expect(env.AWX_AXI_READ_ONLY).toBe("1");
  });

  it("executes live reads with the supplied bearer token", async () => {
    const fixture = fixtureFetch(["unified-jobs-page-1"]);
    const fetch = vi.fn(fixture.fetch);
    vi.stubGlobal("fetch", fetch);
    try {
      const run = await runLiveCli(["job", "list", "--limit", "1"], {
        env: {
          AWX_AXI_LIVE: "1",
          AWX_AXI_ORIGIN: "https://awx.example.com",
          AWX_AXI_TOKEN: "test-token",
          ...isolatedEnv,
        },
      });

      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("Deploy web tier #1000");
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("https://awx.example.com/api/v2/unified_jobs/?"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
