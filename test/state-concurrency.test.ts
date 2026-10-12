import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrivateFiles } from "../src/core/private-file.js";
import { configPath, credentialsPath, loadCredentials, writeLogPath, type Env } from "../src/core/profiles.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "awx-state-concurrency-"));
const compiled = join(temporary, "compiled");
const files = new PrivateFiles();

beforeAll(() => {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  ts.createProgram([
    join(root, "src/commands/auth.ts"), join(root, "src/core/transport.ts"),
  ], { ...parsed.options, outDir: compiled }).emit();
  files.write(join(compiled, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(root, "node_modules"), join(compiled, "node_modules"), "junction");
});
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function environment(): Env {
  const home = mkdtempSync(join(temporary, "home-"));
  return {
    HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"), APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "synthetic-password",
    AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_SECURITY_WRITES: "1",
  };
}

async function concurrent(env: Env, commands: readonly string[]): Promise<void> {
  const workers = commands.map((command) => {
    const child = fork(fileURLToPath(new URL("support/state-worker.mjs", import.meta.url)), [compiled], {
      execArgv: [], env: { ...process.env, ...env }, silent: true,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const ready = once(child, "message");
    const done = once(child, "exit").then(([code]) => {
      if (code !== 0) throw new Error(`state worker failed: ${stderr}`);
    });
    return { child, ready, done, command };
  });
  try {
    await Promise.all(workers.map((worker) => Promise.race([
      worker.ready, worker.done.then(() => { throw new Error("state worker exited before ready"); }),
    ])));
    for (const worker of workers) worker.child.send({ env, command: worker.command });
    await Promise.all(workers.map((worker) => worker.done));
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
  }
}

describe("state transactions across CLI processes", () => {
  it("serializes two stale-lock reclaimers with complete owner records", async () => {
    const env = environment();
    const path = join(env.XDG_STATE_HOME!, "reclamation");
    const owner = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({pid:process.pid,startTime:Date.now()}))"], { encoding: "utf8", env: { ...process.env, ...env } });
    files.write(`${path}.lock`, owner);
    await concurrent(env, ["reclaim", "reclaim"]);
    const entries = readFileSync(path, "utf8").trim().split("\n");
    expect(entries).toHaveLength(40);
    expect(new Set(entries).size).toBe(2);
  }, 15000);

  it("retains every journal entry from two concurrent processes", async () => {
    const env = environment();
    await concurrent(env, ["journal", "journal"]);
    const entries = readFileSync(writeLogPath(env), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { method: string; status: number });
    expect(entries).toHaveLength(40);
    expect(entries.map(({ method, status }) => ({ method, status })))
      .toEqual(Array.from({ length: 40 }, () => ({ method: "POST", status: 204 })));
  }, 15000);

  it("retains concurrent logins and removes concurrent logouts for different profiles", async () => {
    const env = environment();
    const profiles = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      [`login-${index}`, { origin: "https://awx.example.com" }],
      [`logout-${index}`, { origin: "https://awx.example.com" }],
    ]).flat());
    files.write(configPath(env), JSON.stringify({ version: 1, profiles }));
    files.write(credentialsPath(env), JSON.stringify({ version: 1, profiles: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`logout-${index}`, { origin: "https://awx.example.com", token: `old-pat-${index}`, id: index + 1 }]),
    ) }));
    await concurrent(env, ["login", "logout"]);
    expect(loadCredentials(env).profiles).toEqual(Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`login-${index}`, { origin: "https://awx.example.com", token: `synthetic-pat-${index}`, id: index + 1 }]),
    ));
  }, 15000);
});
