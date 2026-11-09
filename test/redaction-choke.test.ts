import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defineDomain, delay } from "../src/core/registry.js";
import { runCli } from "./support/run.js";

const WRITES_ON = { AWX_AXI_ALLOW_SECURITY_WRITES: "1", AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_CONFIG_WRITES: "1" };
const SSH_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAsecretkeybody\n-----END OPENSSH PRIVATE KEY-----";
const SSH_BODY = "b3BlbnNzaC1rZXktdjEAAAAAsecretkeybody";

async function withPrivateFile(content: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "awx-axi-choke-"));
  try {
    const file = join(dir, "private.txt");
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
    await run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("secret redaction choke point", () => {
  it("keeps the protocol error code when a registered password equals it (issue #75)", async () => {
    await withPrivateFile("FORBIDDEN", async (file) => {
      const run = await runCli(["user", "create", "alice", "--password-file", file, "--confirm"], {
        env: WRITES_ON,
        script: [{ status: 403, body: { detail: "You do not have permission." } }],
      });
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toContain("code: FORBIDDEN");
    });
  });

  it.each([
    ["ssh_key_data", SSH_KEY, SSH_KEY],
    ["ssh_key_unlock", "unlock-passphrase-1", "unlock-passphrase-1"],
    ["extra_vars", '{"db_pass_token":"s3cr3t-extra-var"}', "s3cr3t-extra-var"],
    ["extra_vars", "vault_password: s3cr3t-yaml-var\nenv: prod", "s3cr3t-yaml-var"],
    ["credential_passwords", { ssh_password: "s3cr3t-launch-pw" }, "s3cr3t-launch-pw"],
    ["inputs", { client_secret: "s3cr3t-client-id" }, "s3cr3t-client-id"],
  ])("masks %s in dry-run previews, controller echoes and error details", async (field, value, secret) => {
    await withPrivateFile(JSON.stringify({ [field]: value }), async (file) => {
      const args = ["api", "post", "credentials/", "--body-file", file];
      const preview = await runCli(args);
      const echoed = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 201, body: { echoed: secret } }] });
      const rejected = await runCli([...args, "--confirm"], { env: WRITES_ON, script: [{ status: 400, body: { detail: secret } }] });
      for (const run of [preview, echoed, rejected]) expect(run.stdout).not.toContain(secret);
      expect(preview.stdout).toContain("would_send: POST credentials/");
    });
  });

  it.each([
    ["ssh_key_data", { id: 7, ssh_key_data: SSH_KEY }, SSH_BODY],
    ["ssh_key_unlock", { id: 7, ssh_key_unlock: "unlock-passphrase-2" }, "unlock-passphrase-2"],
    ["credential inputs", { id: 7, credential_type: 1, inputs: { username: "svc-account-name", extra: "plain-input-field" } }, "plain-input-field"],
    ["json extra_vars", { id: 7, extra_vars: '{"api_token":"s3cr3t-job-token"}' }, "s3cr3t-job-token"],
    ["yaml extra_vars", { id: 7, extra_vars: "vault_password: s3cr3t-job-yaml\n" }, "s3cr3t-job-yaml"],
    ["unparseable extra_vars", { id: 7, extra_vars: "{unterminated: s3cr3t-broken" }, "s3cr3t-broken"],
  ])("masks %s in raw GET output", async (_name, body, secret) => {
    const run = await runCli(["api", "get", "jobs/7/"], { script: [{ status: 200, body }] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain(secret);
    expect(run.stdout).toContain("id: 7");
  });

  it("keeps non-secret extra_vars visible in raw GET output", async () => {
    const run = await runCli(["api", "get", "jobs/7/"], { script: [{ status: 200, body: { extra_vars: '{"env":"production"}' } }] });
    expect(run.stdout).toContain("production");
  });

  it("registers write-body secrets from any domain before a controller error can echo them", async () => {
    const secret = "s3cr3t-team-credential";
    await withPrivateFile(JSON.stringify({ name: "cred", credential_type: 1, inputs: { password: secret } }), async (file) => {
      const run = await runCli(["team", "credential", "create", "5", "--name", "cred", "--credential-type", "1", "--inputs-file", file, "--confirm"], {
        env: WRITES_ON,
        script: [{ status: 400, body: { detail: `bad input ${secret}` } }],
      });
      expect(run.stdout).not.toContain(secret);
    });
  });

  it("redacts a domain result that bypasses detailOutput", async () => {
    const domain = defineDomain({
      name: "leaky",
      help: "leaky: a fake domain returning raw objects",
      subcommands: [{
        name: "show",
        help: "leaky show",
        flags: [],
        positionals: { names: [], required: 0 },
        schema: { label: "leaky", defaultFields: [], fieldAllowlist: [] },
        suggestions: [],
        *plan() {
          yield* delay(0);
          return { leaky: { ssh_key_data: SSH_KEY, note: `log line with ${SSH_KEY}`, url: "https://user:hunter2hunter2@git.example/repo" } };
        },
      }],
    });
    const run = await runCli(["leaky", "show"], { domain });
    expect(run.stdout).not.toContain(SSH_BODY);
    expect(run.stdout).not.toContain("hunter2hunter2");
  });
});

describe("redaction guard", () => {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
  const files = sources(srcRoot).map((path) => ({ name: relative(srcRoot, path), text: readFileSync(path, "utf8") }));

  it("encodes output only in modules that apply the redaction choke point", () => {
    const encoders = files.filter((file) => file.text.includes("@toon-format/toon")).map((file) => file.name).sort();
    expect(encoders).toEqual(["cli.ts", "core/errors.ts", "core/output.ts", "domains/host/index.ts"]);
    const errors = files.find((file) => file.name === "core/errors.ts")!.text;
    expect(errors.split("\n").filter((line) => /\bencode\(/.test(line) && !line.includes("encode(redactValue("))).toEqual([]);
  });

  it("writes to the process streams only through redact or from fixed text", () => {
    const writes = files.flatMap((file) => file.text.split("\n")
      .filter((line) => /process\.(?:stdout|stderr)|console\./.test(line))
      .map((line) => `${file.name}: ${line.trim()}`));
    expect(writes).toEqual([
      "cli.ts: (options.stdout ?? process.stdout).write(error.output);",
      "cli.ts: (options.stdout ?? process.stdout).write(error.output);",
      "cli.ts: stdout: options.stdout ?? process.stdout,",
      'core/auth.ts: if (profile.origin.startsWith("http://")) process.stderr.write("warning: plain HTTP controller traffic, including credentials, is unencrypted\\n");',
      "core/profiles.ts: export function normalizeEnv(env: Env, notice: (message: string) => void = (message) => process.stderr.write(`${message}\\n`)): Env {",
      "core/transport.ts: process.stderr.write(redact(`Write journal failed after ${method} returned ${response.status}: ${String(error)}\\n`));",
    ]);
  });

  it("routes every command result through redactResult", () => {
    const cli = files.find((file) => file.name === "cli.ts")!.text;
    expect(cli).toContain("redactResult((await command(args, commandContext))");
    expect(cli).toContain("home: () => redactResult(home!)");
  });
});
