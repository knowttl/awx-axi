import { describe, expect, it } from "vitest";

import { buildLiveEnv } from "./live/support/live.js";

describe("live suite gate behavior", () => {
  it("fails when live mode is not opt-in", () => {
    expect(() => buildLiveEnv({})).toThrowError(
      /AWX_AXI_LIVE=1 to run the live suite/,
    );
  });

  it("fails when controller config is incomplete", () => {
    expect(() =>
      buildLiveEnv({ AWX_AXI_LIVE: "1", CONTROLLER_HOST: "https://awx.example.com" }),
    ).toThrowError(/must be set to run live checks/);

    expect(() =>
      buildLiveEnv({
        AWX_AXI_LIVE: "1",
        CONTROLLER_HOST: "https://awx.example.com",
        CONTROLLER_USERNAME: "btsai",
      }),
    ).toThrowError(/must be set to run live checks/);
  });

  it("enforces read-only mode for live runs", () => {
    const env = buildLiveEnv({
      AWX_AXI_LIVE: "1",
      CONTROLLER_HOST: "https://awx.example.com",
      CONTROLLER_USERNAME: "btsai",
      CONTROLLER_PASSWORD: "hunter2",
    });

    expect(env.AWX_AXI_READ_ONLY).toBe("1");
  });
});
