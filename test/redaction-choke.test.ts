import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";

import { defineDomain, delay } from "../src/core/registry.js";
import { runCli } from "./support/run.js";
import { checkOutput } from "../scripts/check-output.mjs";

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
      expect(echoed.exitCode).toBe(0);
      expect(echoed.stdout).toContain("echoed: ***");
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stdout).toContain("***");
    });
  });

  it.each([
    ["ssh_key_data", { id: 7, ssh_key_data: SSH_KEY }, SSH_BODY, "ssh_key_data"],
    ["ssh_key_unlock", { id: 7, ssh_key_unlock: "unlock-passphrase-2" }, "unlock-passphrase-2", "ssh_key_unlock"],
    ["credential inputs", { id: 7, credential_type: 1, inputs: { username: "svc-account-name", extra: "plain-input-field" } }, "plain-input-field", "inputs"],
    ["json extra_vars", { id: 7, extra_vars: '{"api_token":"s3cr3t-job-token"}' }, "s3cr3t-job-token", "extra_vars"],
    ["yaml extra_vars", { id: 7, extra_vars: "vault_password: s3cr3t-job-yaml\n" }, "s3cr3t-job-yaml", "extra_vars"],
    ["unparseable extra_vars", { id: 7, extra_vars: "{unterminated: s3cr3t-broken" }, "s3cr3t-broken", "extra_vars"],
  ])("masks %s in raw GET output", async (_name, body, secret, field) => {
    const run = await runCli(["api", "get", "jobs/7/"], { script: [{ status: 200, body }] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain(secret);
    expect(decode(run.stdout)).toMatchObject({ api_response: { body: { id: 7, [field]: "***" } } });
  });

  it("keeps non-secret extra_vars visible in raw GET output", async () => {
    const run = await runCli(["api", "get", "jobs/7/"], { script: [{ status: 200, body: { extra_vars: '{"env":"production"}' } }] });
    expect(run.stdout).toContain("production");
  });

  it("registers write-body secrets from any domain before a controller error can echo them", async () => {
    const secret = "s3cr3t-team-credential";
    await withPrivateFile(JSON.stringify({ name: "cred", credential_type: 1, inputs: { password: secret } }), async (file) => {
      const run = await runCli(["team", "credential-create", "5", "--name", "cred", "--credential-type", "1", "--inputs-file", file, "--confirm"], {
        env: WRITES_ON,
        script: [{ status: 400, body: { detail: `bad input ${secret}` } }],
      });
      expect(run.stdout).not.toContain(secret);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("bad input ***");
    });
  });

  it("redacts a short private password echoed by the controller", async () => {
    await withPrivateFile("abc123", async (file) => {
      const run = await runCli(["user", "create", "alice", "--password-file", file, "--confirm"], {
        env: WRITES_ON, script: [{ status: 400, body: { detail: "invalid password abc123" } }],
      });
      expect(run.stdout).toContain("invalid password ***");
      expect(run.stdout).not.toContain("abc123");
    });
  });

  it("redacts a registered long password inside a longer token", async () => {
    await withPrivateFile("abc12345", async (file) => {
      const run = await runCli(["user", "create", "alice", "--password-file", file, "--confirm"], {
        env: WRITES_ON, script: [{ status: 400, body: { detail: "invalid abc12345suffix" } }],
      });
      expect(run.stdout).toContain("invalid ***suffix");
      expect(run.stdout).not.toContain("abc12345");
    });
  });

  it("applies the original short-secret boundary to URL encoding", async () => {
    await withPrivateFile("éé", async (file) => {
      const run = await runCli(["user", "create", "alice", "--password-file", file, "--confirm"], {
        env: WRITES_ON, script: [{ status: 400, body: { detail: "x%C3%A9%C3%A9y and %C3%A9%C3%A9" } }],
      });
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("x%C3%A9%C3%A9y and ***");
    });
  });

  it("redacts credential edit inputs without a credential type", async () => {
    await withPrivateFile('{"custom_field":"longsecret"}', async (file) => {
      const run = await runCli(["credential", "edit", "7", "--inputs-file", file, "--confirm"], {
        env: WRITES_ON, script: [{ status: 400, body: { detail: "invalid longsecret" } }],
      });
      expect(run.transport.requests[0]).toMatchObject({ method: "PATCH", route: "credentials/7/", body: { inputs: { custom_field: "longsecret" } } });
      expect(run.stdout).toContain("invalid ***");
      expect(run.stdout).not.toContain("longsecret");
    });
  });

  it("redacts controller protocol fields and response echoes", async () => {
    const run = await runCli(["api", "get", "jobs/7/"], { script: [{ status: 200, body: {
      message: "echo longsecret", status: ["rejected: longsecret"], code: "longsecret", action: ["longsecret"], password: "longsecret",
    } }] });
    expect(run.stdout).not.toContain("longsecret");
    expect(run.stdout).toContain("echo ***");
    expect(run.stdout).toContain("rejected: ***");
  });

  it("preserves the CLI dry-run action when it equals a password", async () => {
    await withPrivateFile("create", async (file) => {
      const run = await runCli(["user", "create", "alice", "--password-file", file]);
      expect(run.stdout).toContain("action: create");
    });
  });

  it("registers numeric response secrets before masking", async () => {
    const run = await runCli(["api", "get", "jobs/7/"], { script: [{ status: 200, body: { password: 123456, message: "echo 123456" } }] });
    expect(run.stdout).toContain("echo ***");
    expect(run.stdout).not.toContain("123456");
  });

  it("registers dedicated command error response secrets", async () => {
    const run = await runCli(["user", "show", "7"], { script: [{ status: 400, body: { password: "longsecret", detail: "echo longsecret" } }] });
    expect(run.stdout).toContain("echo ***");
    expect(run.stdout).not.toContain("longsecret");
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
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("log line with ***");
    expect(run.stdout).not.toContain(SSH_BODY);
    expect(run.stdout).not.toContain("hunter2hunter2");
  });
});

describe("redaction guard", () => {
  it.each(["process.stdout.write(secret)", "process.stderr.write(secret)", "process['stdout'].write(secret)", "process['stderr'].write(secret)", "console.log(secret)", "encode(secret)", "import { encode } from '@toon-format/toon'; const render = encode; render(secret)", "import { encode as render } from '@toon-format/toon'; render(secret)"])("rejects bypass %s", (source) => {
    expect(checkOutput([["new.ts", source]])).not.toEqual([]);
  });

  it.each(["stdout", "stderr"])("rejects an imported %s stream", (stream) => {
    expect(checkOutput([["new.ts", `import { ${stream} as output } from 'node:process'; output.write(secret)`]])).not.toEqual([]);
  });

  describe.each(["stdout", "stderr"])("%s stream spellings", (stream) => {
    it.each([
      ["bracket notation", `process['${stream}'].write(secret)`],
      ["template bracket notation", `process[\`${stream}\`].write(secret)`],
      ["default import", `import proc from 'node:process'; proc.${stream}.write(secret)`],
      ["default import with bracket notation", `import proc from 'process'; proc['${stream}'].write(secret)`],
      ["named default import", `import { default as proc } from 'node:process'; proc.${stream}.write(secret)`],
      ["named default import from process", `import { default as proc } from 'process'; proc.${stream}.write(secret)`],
      ["namespace import", `import * as proc from 'node:process'; proc.${stream}.write(secret)`],
      ["destructured global process", `const { ${stream} } = process; ${stream}.write(secret)`],
      ["renamed destructured global process", `const { ${stream}: out } = process; out.write(secret)`],
      ["computed-key destructured global process", `const { ['${stream}']: out } = process; out.write(secret)`],
      ["dynamic-key destructured global process", `const key = '${stream}'; const { [key]: out } = process; out.write(secret)`],
      ["destructured default import", `import proc from 'node:process'; const { ${stream} } = proc; ${stream}.write(secret)`],
      ["destructured namespace import", `import * as proc from 'node:process'; const { ${stream} } = proc; ${stream}.write(secret)`],
      ["destructuring assignment", `let out; ({ ${stream}: out } = process); out.write(secret)`],
      ["dynamic-key destructuring assignment", `const key = '${stream}'; let out; ({ [key]: out } = process); out.write(secret)`],
      ["globalThis process", `globalThis.process.${stream}.write(secret)`],
      ["globalThis process binding", `const { process: proc } = globalThis; proc.${stream}.write(secret)`],
      ["global process binding", `const { process: proc } = global; proc.${stream}.write(secret)`],
      ["globalThis process assignment", `let proc; ({ process: proc } = globalThis); proc.${stream}.write(secret)`],
      ["global process assignment", `let proc; ({ process: proc } = global); proc.${stream}.write(secret)`],
      ["global process with bracket notation", `global['process']['${stream}'].write(secret)`],
      ["destructured globalThis process", `const { ${stream} } = globalThis.process; ${stream}.write(secret)`],
      ["aliased process", `const p = process; p.${stream}.write(secret)`],
      ["twice aliased process", `const p = process; const q = p; q.${stream}.write(secret)`],
      ["parenthesized process", `(process as NodeJS.Process).${stream}.write(secret)`],
      ["dynamic key", `process[key].write(secret)`],
    ])("rejects %s", (_name, source) => {
      expect(checkOutput([["new.ts", source]])).not.toEqual([]);
    });
  });

  describe.each(["globalThis", "global"])("%s process destructuring", (globalObject) => {
    it.each(["stdout", "stderr"])("rejects computed keys and defaults for %s", (stream) => {
      for (const source of [
        `const { ['process']: proc } = ${globalObject}; proc.${stream}.write(secret)`,
        `const key = 'process'; const { [key]: proc = fallback } = ${globalObject}; proc.${stream}.write(secret)`,
        `let proc; ({ ['process']: proc } = ${globalObject}); proc.${stream}.write(secret)`,
        `const key = 'process'; let proc; ({ [key]: proc = fallback } = ${globalObject}); proc.${stream}.write(secret)`,
        `let proc; ({ process: proc = fallback } = ${globalObject}); proc.${stream}.write(secret)`,
      ]) expect(checkOutput([["new.ts", source]])).not.toEqual([]);
    });
  });

  it.each([
    ["namespace import", "import * as toon from '@toon-format/toon'; toon.encode(secret)"],
    ["default import", "import toon from '@toon-format/toon'; toon.encode(secret)"],
    ["renamed import", "import { encode as render } from '@toon-format/toon'; render(secret)"],
    ["variable alias", "import { encode } from '@toon-format/toon'; const render = encode; render(secret)"],
    ["destructured alias", "import { encode } from '@toon-format/toon'; const { call } = encode; call(secret)"],
    ["call helper", "import { encode } from '@toon-format/toon'; encode.call(undefined, secret)"],
    ["object member alias", "import { encode } from '@toon-format/toon'; const output = { render: encode }; output.render(secret)"],
    ["dynamic import member", "const toon = await import('@toon-format/toon'); const render = toon['encode']; render(secret)"],
    ["direct require member", "const render = require('@toon-format/toon')['encode']; render(secret)"],
    ["direct dynamic import member", "const render = (await import('@toon-format/toon'))[`encode`]; render(secret)"],
    ["aliased require member", "const toon = require('@toon-format/toon'); const other = toon; const render = other['encode']; render(secret)"],
    ["dynamic import destructuring", "const { ['encode']: render } = await import('@toon-format/toon'); render(secret)"],
    ["require destructuring assignment", "let render; ({ ['encode']: render } = require('@toon-format/toon')); render(secret)"],
    ["dynamic import variable key", "const toon = await import('@toon-format/toon'); const key = 'encode'; const render = toon[key]; render(secret)"],
    ["require variable key", "const key = 'encode'; const render = require('@toon-format/toon')[key]; render(secret)"],
    ["dynamic import variable binding", "const key = 'encode'; const { [key]: render } = await import('@toon-format/toon'); render(secret)"],
    ["require variable assignment", "const key = 'encode'; let render; ({ [key]: render } = require('@toon-format/toon')); render(secret)"],
  ])("rejects an encoder reached through %s", (_name, source) => {
    expect(checkOutput([["new.ts", source]])).not.toEqual([]);
  });

  it.each([
    ["process stream", "cli.ts", Array.from({ length: 4 }, () => "process.stdout.write(x);").join("")],
    ["aliased process stream", "cli.ts", "import proc from 'node:process';" + Array.from({ length: 4 }, () => "proc.stdout.write(x);").join("")],
    ["destructured process stream", "cli.ts", "process.stdout.write(x); process.stdout.write(x); process.stderr.write(x); const { stdout } = process;"],
    ["multiple binding streams", "core/auth.ts", "const { stderr, stdout } = process;"],
    ["multiple assignment streams", "core/auth.ts", "let stderr, stdout; ({ stderr, stdout } = process);"],
  ])("counts a %s spelling against the per-file allowance", (_name, file, source) => {
    expect(checkOutput([[file, source]])).toContain(`${file}: unapproved process stream`);
  });

  it.each([
    "const key = 'stdout'; const out = process[key]; out.write(secret)",
    "import { stdout as out } from 'node:process'; out.write(secret)",
    "import proc from 'node:process'; proc.stderr.write(secret)",
    "process.stdout.write(secret)",
  ])("rejects unapproved access in an allowed file: %s", (source) => {
    expect(checkOutput([["core/auth.ts", source]])).not.toEqual([]);
  });

  it.each([
    "const key = 'stdout'; const { [key]: out } = process; out.write(secret)",
    "const key = 'stdout'; let out; ({ [key]: out } = process); out.write(secret)",
  ])("rejects unknown destructured keys regardless of allowance: %s", (source) => {
    expect(checkOutput([["core/auth.ts", source]])).not.toEqual([]);
    expect(checkOutput([["core/auth.ts", `process.stderr.write(x); ${source}`]])).not.toEqual([]);
  });

  it.each([
    "export { cwd } from 'node:process'",
    "export { decode } from '@toon-format/toon'",
    "const toon = await import('@toon-format/toon'); toon.decode(value)",
    "const toon = require('@toon-format/toon'); toon['decode'](value)",
    "const { ['decode']: parse } = await import('@toon-format/toon'); parse(value)",
    "const proc = require('node:process'); proc.cwd()",
    "other.require('node:process')",
  ])("accepts unrelated module operations: %s", (source) => {
    expect(checkOutput([["new.ts", source]])).toEqual([]);
  });

  it("rejects computed process access previously covered by the guard", () => {
    expect(checkOutput([["new.ts", "process['cwd']()"]])).not.toEqual([]);
  });

  it("fails the build for a guarded bypass", () => {
    const root = join(import.meta.dirname, "..");
    const dir = mkdtempSync(join(root, ".guard-build-"));
    try {
      cpSync(join(root, "package.json"), join(dir, "package.json"));
      mkdirSync(join(dir, "scripts"));
      cpSync(join(root, "scripts", "check-output.mjs"), join(dir, "scripts", "check-output.mjs"));
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "bypass.ts"), 'process.stdout.write("secret");');
      const result = spawnSync("npm", ["run", "build"], { cwd: dir, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("bypass.ts: unapproved process stream");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the shipped sources", () => {
    const root = join(import.meta.dirname, "../src");
    const sources = (readdirSync(root, { recursive: true, encoding: "utf8" }))
      .filter((path) => path.endsWith(".ts"))
      .map((path): [string, string] => [path, readFileSync(join(root, path), "utf8")]);
    expect(checkOutput(sources)).toEqual([]);
  });

  it("accepts a command returning data for the output boundary", () => {
    expect(checkOutput([["new.ts", "export const command = () => ({ value: 'example' });"]])).toEqual([]);
  });
});
