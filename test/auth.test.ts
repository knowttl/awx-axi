import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBasicAuthTransport,
  resolveController,
  resolveCredential,
  tokenFilePath,
  writeTokenFile,
} from "../src/core/auth.js";
import { runCli } from "./support/run.js";

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "awx-axi-auth-"));
  homes.push(path);
  return path;
}

afterEach(() => {
  homes.length = 0;
});

describe("credential resolution (design.md §5.1)", () => {
  it("prefers CONTROLLER_OAUTH_TOKEN over the token file", () => {
    const env = {
      AWX_AXI_HOME: home(),
      CONTROLLER_OAUTH_TOKEN: "from-env",
    };
    writeTokenFile(tokenFilePath(env), "from-file");

    expect(resolveCredential(env)).toMatchObject({
      token: "from-env",
      source: "CONTROLLER_OAUTH_TOKEN",
    });
  });

  it("falls back to the token file", () => {
    const env = { AWX_AXI_HOME: home() };
    writeTokenFile(tokenFilePath(env), "from-file");

    expect(resolveCredential(env)).toMatchObject({
      token: "from-file",
      source: "token file",
    });
  });

  it("resolves nothing when neither is present", () => {
    expect(resolveCredential({ AWX_AXI_HOME: home() })).toBeUndefined();
  });

  it("never uses basic auth for an ordinary request, even when it is set", () => {
    const env = {
      AWX_AXI_HOME: home(),
      CONTROLLER_USERNAME: "btsai",
      CONTROLLER_PASSWORD: "hunter2",
    };

    expect(resolveCredential(env)).toBeUndefined();
  });

  it("writes the token file at 0600", () => {
    const env = { AWX_AXI_HOME: home() };
    const path = tokenFilePath(env);

    writeTokenFile(path, "abc123");

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe("abc123");
  });

  it("reads awxkit's own CONTROLLER_* variables (§3.5)", () => {
    const config = resolveController({
      CONTROLLER_HOST: "https://awx.example.com",
      CONTROLLER_VERIFY_SSL: "false",
    });

    expect(config.host).toBe("awx.example.com");
    expect(config.verifySsl).toBe(false);
    expect(config.apiBasePath).toBe("/api/v2/");
  });
});

describe("`auth login` (design.md §5.2)", () => {
  it("mints a token, stores it, and never echoes its value", async () => {
    const path = home();
    const run = await runCli(["auth", "login"], {
      env: {
        HOME: path,
        AWX_AXI_HOME: path,
        CONTROLLER_HOST: "https://awx.example.com",
        CONTROLLER_USERNAME: "btsai",
        CONTROLLER_PASSWORD: "hunter2",
      },
      script: [
        {
          status: 201,
          body: {
            id: 9,
            token: "a-very-secret-token",
            scope: "write",
            summary_fields: { user: { username: "btsai" } },
          },
        },
      ],
    });

    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({
      method: "POST",
      route: "/api/v2/tokens/",
    });
    expect(run.stdout).toContain("user: btsai");
    expect(run.stdout).toContain("scope: write");
    // Not even truncated (§5.2).
    expect(run.stdout).not.toContain("a-very-secret-token");
    expect(run.stdout).not.toContain("a-very");
    expect(readFileSync(join(path, "token"), "utf8").trim()).toBe(
      "a-very-secret-token",
    );
  });

  it("exits 2 and names the missing variables rather than prompting", async () => {
    const path = home();
    const run = await runCli(["auth", "login"], {
      env: {
        HOME: path,
        AWX_AXI_HOME: path,
        CONTROLLER_HOST: "https://awx.example.com",
      },
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("CONTROLLER_USERNAME and CONTROLLER_PASSWORD");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("is refused by the read-only boundary, because minting is a POST (§6.5)", async () => {
    const path = home();
    const run = await runCli(["auth", "login"], {
      env: {
        HOME: path,
        AWX_AXI_HOME: path,
        AWX_AXI_READ_ONLY: "1",
        CONTROLLER_HOST: "https://awx.example.com",
        CONTROLLER_USERNAME: "btsai",
        CONTROLLER_PASSWORD: "hunter2",
      },
      script: [{ status: 201, body: { token: "never-minted" } }],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: READ_ONLY_VIOLATION");
    expect(run.stdout).toContain("POST /api/v2/tokens/");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("builds a Basic authorization header, and only for login", () => {
    const transport = createBasicAuthTransport({
      CONTROLLER_HOST: "https://awx.example.com",
      CONTROLLER_USERNAME: "btsai",
      CONTROLLER_PASSWORD: "hunter2",
    });

    expect(transport).toBeDefined();
  });
});

describe("`auth status` and `auth logout` (design.md §5.3)", () => {
  it("reports the source and the user, never the value", async () => {
    const path = home();
    writeTokenFile(join(path, "token"), "a-very-secret-token");

    const run = await runCli(["auth", "status"], {
      env: {
        HOME: path,
        AWX_AXI_HOME: path,
        CONTROLLER_HOST: "https://awx.example.com",
      },
      script: [{ status: 200, body: { results: [{ username: "btsai" }] } }],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("controller: awx.example.com");
    expect(run.stdout).toContain("user: btsai");
    expect(run.stdout).toContain("valid: true");
    expect(run.stdout).not.toContain("a-very-secret-token");
  });

  it("answers the no-credential case at exit 0 with the next command", async () => {
    const path = home();
    const run = await runCli(["auth", "status"], {
      env: {
        HOME: path,
        AWX_AXI_HOME: path,
        CONTROLLER_HOST: "https://awx.example.com",
      },
      script: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("source: none");
    expect(run.stdout).toContain("valid: false");
    expect(run.stdout).toContain("awx-axi auth login");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("logout is an exit-0 no-op when there is nothing stored", async () => {
    const path = home();
    const run = await runCli(["auth", "logout"], {
      env: { HOME: path, AWX_AXI_HOME: path },
      script: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("(no-op)");
  });

  it("rejects an unknown auth subcommand by name", async () => {
    const run = await runCli(["auth", "refresh"], {
      env: { AWX_AXI_HOME: home() },
      script: [],
    });

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("code: VALIDATION_ERROR");
    expect(run.stdout).toContain("login, status, logout");
  });
});
