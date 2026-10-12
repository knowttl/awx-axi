import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateFiles } from "../src/core/private-file.js";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "awx-axi-private-"));
  directories.push(path);
  return path;
}
afterEach(() => { directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

describe("private-file transaction locks", () => {
  it("releases the lock when a transaction fails", () => {
    const path = join(directory(), "state");
    const files = new PrivateFiles();
    expect(() => files.withLock(path, () => { throw new Error("transaction failed"); })).toThrow("transaction failed");
    expect(existsSync(`${path}.lock`)).toBe(false);
    files.withLock(path, () => files.write(path, "replacement"));
    expect(files.read(path, true)).toBe("replacement");
  });

  it("times out rather than removing a live owner's lock", () => {
    const path = join(directory(), "state");
    const files = new PrivateFiles({ wait: () => {} });
    files.withLock(path, () => {
      expect(() => files.withLock(path, () => files.write(path, "unexpected")))
        .toThrow(/timed out waiting for file lock/);
      expect(JSON.parse(files.read(`${path}.lock`, true)!)).toEqual({ pid: process.pid, startTime: expect.any(Number) });
    });
    expect(existsSync(path)).toBe(false);
  });

  it("recovers a lock whose owning process has exited", () => {
    const path = join(directory(), "state");
    const owner = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const files = new PrivateFiles();
    files.write(`${path}.lock`, JSON.stringify({ pid: Number(owner), startTime: 1 }));
    files.withLock(path, () => files.write(path, "recovered"));
    expect(files.read(path, true)).toBe("recovered");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("protects a Windows lock before writing its owner", () => {
    const parent = directory();
    const path = join(parent, "state");
    const files = new PrivateFiles({ platform: "win32", acl: (target, action, isDirectory) => {
      if (!isDirectory && action === "restrict") {
        expect(readFileSync(target, "utf8")).toBe("");
        expect(existsSync(`${path}.lock`)).toBe(false);
      }
    } });
    files.withLock(path, () => {
      expect(JSON.parse(files.read(`${path}.lock`, true)!)).toEqual({ pid: process.pid, startTime: expect.any(Number) });
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("never publishes an ownerless lock when owner preparation fails", () => {
    const parent = directory();
    const path = join(parent, "state");
    const files = new PrivateFiles({ platform: "win32", acl: (_target, action, isDirectory) => {
      if (!isDirectory && action === "restrict") throw new Error("ACL failure");
    } });
    expect(() => files.withLock(path, () => {})).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("private files on POSIX", () => {
  it("writes atomically and tightens an existing directory", () => {
    const parent = directory();
    const path = join(parent, "credentials.json");
    chmodSync(parent, 0o755);
    const files = new PrivateFiles();
    files.write(path, "original");
    files.write(path, "replacement");
    expect(files.read(path, true)).toBe("replacement");
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(parent)).toEqual(["credentials.json"]);
  });

  it.each([0o640, 0o604, 0o610, 0o601])("rejects group or other access for secrets: %s", (mode) => {
    const path = join(directory(), "secret");
    const files = new PrivateFiles();
    files.write(path, "must-not-read");
    chmodSync(path, mode);
    expect(() => files.read(path, true)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  });

  it("accepts read-only 0400 secrets and readable 0644 config", () => {
    const path = join(directory(), "config");
    const files = new PrivateFiles();
    files.write(path, "safe");
    chmodSync(path, 0o400);
    expect(files.read(path, true)).toBe("safe");
    chmodSync(path, 0o644);
    expect(files.read(path)).toBe("safe");
  });

  it("rejects files belonging to a different uid", () => {
    const path = join(directory(), "config");
    new PrivateFiles().write(path, "safe");
    expect(() => new PrivateFiles({ uid: statSync(path).uid + 1 }).read(path)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  });

  it("cleans up failed atomic writes and preserves the prior value", () => {
    const parent = directory();
    const path = join(parent, "credentials.json");
    new PrivateFiles().write(path, "original");
    const files = new PrivateFiles({ rename: () => { throw new Error("write failure"); } });
    expect(() => files.write(path, "replacement")).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(readdirSync(parent)).toEqual(["credentials.json"]);
  });

  it("rejects symlink reads and writes", () => {
    const parent = directory();
    const target = join(parent, "target");
    const link = join(parent, "link");
    const files = new PrivateFiles();
    files.write(target, "original");
    symlinkSync(target, link);
    expect(() => files.read(link)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
    expect(() => files.write(link, "replacement")).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
    expect(files.read(target)).toBe("original");
  });

  it.each(["linux", "win32"] as const)("accepts private targets beneath symlink ancestors on %s", (platform) => {
    const parent = directory();
    const target = join(parent, "target");
    const files = new PrivateFiles({ platform, acl: () => {} });
    files.write(join(target, "secret"), "original");
    const link = join(parent, "link");
    symlinkSync(target, link);
    expect(files.read(join(link, "secret"), true)).toBe("original");
    files.write(join(link, "secret"), "replacement");
    expect(files.read(join(target, "secret"), true)).toBe("replacement");
  });

  it.each(["linux", "win32"] as const)("rejects dangling target symlinks on %s", (platform) => {
    const parent = directory();
    const link = join(parent, "link");
    symlinkSync(join(parent, "missing"), link);
    const files = new PrivateFiles({ platform, acl: () => {} });
    expect(() => files.read(link, true)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
    expect(() => files.write(link, "replacement")).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  });
});

describe("Windows private files with injected ACL operations", () => {
  it("protects directories and the temporary file before writing secret content", () => {
    const parent = directory();
    const path = join(parent, "credentials.json");
    const protectedPaths: string[] = [];
    const files = new PrivateFiles({ platform: "win32", acl: (target, action, isDirectory) => {
      expect(action).toBe("restrict");
      if (!isDirectory) expect(readFileSync(target, "utf8")).toBe("");
      protectedPaths.push(target);
    } });
    files.write(path, "secret");
    expect(protectedPaths[0]).toBe(parent);
    expect(protectedPaths[1]).toContain(".tmp");
    expect(readFileSync(path, "utf8")).toBe("secret");
  });

  it("ignores POSIX mode bits and verifies DACLs only when requested", () => {
    const path = join(directory(), "config");
    new PrivateFiles().write(path, "safe");
    chmodSync(path, 0o666);
    const actions: string[] = [];
    const files = new PrivateFiles({ platform: "win32", acl: (_path, action) => { actions.push(action); } });
    expect(files.read(path, true)).toBe("safe");
    expect(actions).toEqual(["check"]);
    expect(files.read(path, true, true)).toBe("safe");
    expect(actions).toEqual(["check", "check", "verify"]);
  });

  it("fails closed on an insecure Windows DACL", () => {
    const path = join(directory(), "config");
    new PrivateFiles().write(path, "safe");
    const files = new PrivateFiles({ platform: "win32", acl: (_path, action) => { if (action === "verify") throw new Error("broad ACL"); } });
    expect(() => files.read(path, true, true)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  });

  it("retries transient Windows rename failures with bounded backoff", () => {
    const path = join(directory(), "credentials.json");
    const delays: number[] = [];
    let attempts = 0;
    const files = new PrivateFiles({ platform: "win32", acl: () => {}, wait: (ms) => { delays.push(ms); }, rename: (source, destination) => {
      if (attempts++ < 2) throw Object.assign(new Error("indexer lock"), { code: "EPERM" });
      renameSync(source, destination);
    } });
    files.write(path, "secret");
    expect(readFileSync(path, "utf8")).toBe("secret");
    expect(delays).toEqual([50, 100]);
  });
});
