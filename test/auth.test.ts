import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBasicAuthTransport, createTransport, resolveController, resolveCredential } from "../src/core/auth.js";
import { authCommand } from "../src/commands/auth.js";
import { RecordedTransport } from "../src/core/transport.js";
import { PrivateFiles } from "../src/core/private-file.js";
import { booleanEnv, configPath, credentialsPath, deleteToken, loadConfig, loadCredentials, normalizeEnv, saveToken, selectProfile, toolDirectory, validateOrigin, validateRef, type Env } from "../src/core/profiles.js";
import { runCli } from "./support/run.js";

const homes: string[] = [];
const files = new PrivateFiles();
function environment(): Env {
  const path = mkdtempSync(join(tmpdir(), "awx-axi-auth-"));
  homes.push(path);
  return { HOME: path, XDG_CONFIG_HOME: join(path, "config"), XDG_STATE_HOME: join(path, "state"), XDG_CACHE_HOME: join(path, "cache"), APPDATA: join(path, "appdata"), LOCALAPPDATA: join(path, "localappdata"), AWX_AXI_HOME: join(path, "legacy") };
}
function configure(env: Env, profiles: Record<string, unknown>, defaultProfile?: string): void {
  files.write(configPath(env), JSON.stringify({ version: 1, profiles, ...(defaultProfile ? { defaultProfile } : {}) }));
}
const production = { origin: "https://awx.example.com", token: { env: "PRODUCTION_PAT" } };
const commandSecret = 'synthetic-command/password"value';
const secretInputs = JSON.stringify({ ssh_password: commandSecret, nested: [{ value: commandSecret }] });
const passwordPreflight = [{ status: 200, body: { passwords_needed_to_start: ["ssh_password"] } }];
afterEach(() => { homes.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

describe("credential profiles", () => {
  it.each([
    ["https://awx.example.com", false],
    ["https://awx.example.com", true],
    ["http://awx.example.com", true],
  ])("accepts origin %s with allowHttp=%s", (origin, allowHttp) => {
    expect(validateOrigin(origin, allowHttp)).toBe(origin);
  });

  it.each(["http://awx.example.com/path", "http://awx.example.com/..", "http://user@awx.example.com", "http://awx.example.com/?query", "http://awx.example.com/#fragment"])("refuses unsafe HTTP origins even with consent: %s", (origin) => {
    expect(() => validateOrigin(origin, true)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it.each([undefined, false, "true"])("refuses HTTP without a boolean profile opt-in: %s", (allowHttp) => {
    const env = environment();
    configure(env, { production: { origin: "http://awx.example.com", allowHttp, token: { env: "PRODUCTION_PAT" } } });
    expect(() => createTransport({ ...env, PRODUCTION_PAT: "synthetic-token" })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it.each(["1", "true", "TRUE"])("allows HTTP env profile with AWX_AXI_ALLOW_HTTP=%s", (value) => {
    const env = { ...environment(), AWX_AXI_ORIGIN: "http://awx.example.com", AWX_AXI_TOKEN: "synthetic-token", AWX_AXI_ALLOW_HTTP: value };
    expect(selectProfile(env).profile).toMatchObject({ origin: env.AWX_AXI_ORIGIN, allowHttp: true });
  });

  it.each([undefined, "0", "false", "yes", ""])("refuses HTTP env profile with AWX_AXI_ALLOW_HTTP=%s", (value) => {
    const env = { ...environment(), AWX_AXI_ORIGIN: "http://awx.example.com", AWX_AXI_TOKEN: "synthetic-token", AWX_AXI_ALLOW_HTTP: value };
    expect(() => createTransport(env)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("rejects a malformed HTTP opt-in even for HTTPS env profiles", () => {
    expect(() => selectProfile({ ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_TOKEN: "synthetic-token", AWX_AXI_ALLOW_HTTP: "yes" })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("keeps HTTP consent scoped to the selected profile", () => {
    const env = { ...environment(), AWX_AXI_ALLOW_HTTP: "1", PRODUCTION_PAT: "synthetic-token" };
    configure(env, { allowed: { origin: "http://awx.example.com", allowHttp: true }, production });
    expect(selectProfile(env, { profile: "allowed" }).profile.origin).toBe("http://awx.example.com");
    expect(() => createTransport(env, { profile: "production", origin: "http://awx.example.com" })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("warns on stderr when constructing an HTTP transport", () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: "http://awx.example.com", AWX_AXI_TOKEN: "synthetic-token", AWX_AXI_ALLOW_HTTP: "1" };
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      createTransport(env);
      expect(warning).toHaveBeenCalledExactlyOnceWith("warning: plain HTTP controller traffic, including credentials, is unencrypted\n");
    } finally { warning.mockRestore(); }
  });

  it("refuses HTTP token minting before creating a Basic auth transport", () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: "http://awx.example.com", AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "synthetic-password" };
    expect(() => createBasicAuthTransport(env)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it.each(["named", "env"])("persists login HTTP consent only for the %s profile", async (name) => {
    const env = { ...environment(), AWX_AXI_ORIGIN: "http://awx.example.com", AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "synthetic-password" };
    configure(env, { named: { origin: env.AWX_AXI_ORIGIN }, production });
    const argv = name === "named" ? ["--profile", "named"] : [];
    const run = await runCli(["auth", "login", "--allow-http", ...argv], { env, script: [{ status: 201, body: { id: 9, token: "synthetic-minted-token" } }] });
    expect(run.exitCode).toBe(0);
    expect(loadConfig(env).profiles[name]).toMatchObject({ allowHttp: true, origin: env.AWX_AXI_ORIGIN });
    expect(loadConfig(env).profiles.production).toEqual(production);
    expect(resolveCredential(env, { profile: name })).toMatchObject({ token: "synthetic-minted-token" });
  });

  it("does not persist HTTP consent after a failed login", async () => {
    const env = { ...environment(), AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "synthetic-password" };
    configure(env, { production: { origin: "http://awx.example.com" } });
    const run = await runCli(["auth", "login", "--allow-http"], { env, script: [{ status: 401 }] });
    expect(run.exitCode).not.toBe(0);
    expect(loadConfig(env).profiles.production?.allowHttp).toBeUndefined();
    expect(loadCredentials(env).profiles).toEqual({});
  });

  it.each(["https://awx.example.com/controller/..", "https://awx.example.com/.", "https://awx.example.com/%2e", "https://awx.example.com/controller/%2e%2e", "https://awx.example.com\\controller\\..", "https://awx.example.com/\n"])("rejects paths before origin normalization: %s", (origin) => {
    expect(() => validateOrigin(origin)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it.each(["https://awx.example.com", "https://awx.example.com/"])("accepts root origins: %s", (origin) => {
    expect(validateOrigin(origin)).toBe(production.origin);
  });

  it("rejects a competing implicit login after both pre-mint checks pass", async () => {
    const env = { ...environment(), AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "synthetic-password" };
    const first = new RecordedTransport([{ status: 201, body: { id: 1, token: "first-token" } }], { env });
    const second = new RecordedTransport([{ status: 201, body: { id: 2, token: "second-token" } }], { env });
    const outcomes = await Promise.allSettled([
      authCommand(["login"], { env: { ...env, AWX_AXI_ORIGIN: production.origin }, selection: {}, createTransport: () => first, createBasicAuthTransport: () => first }),
      authCommand(["login"], { env: { ...env, AWX_AXI_ORIGIN: "https://other.example.com" }, selection: {}, createTransport: () => second, createBasicAuthTransport: () => second }),
    ]);
    expect(outcomes).toMatchObject([{ status: "fulfilled" }, { status: "rejected", reason: { code: "CONFIG_INVALID" } }]);
    expect(loadCredentials(env).profiles.env).toEqual({ origin: production.origin, token: "first-token", id: 1 });
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it("retains a replacement saved while logout revokes the old PAT", async () => {
    const env = { ...environment(), AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_SECURITY_WRITES: "1" };
    configure(env, { production: { origin: production.origin } });
    const selected = selectProfile(env);
    saveToken(env, selected, { origin: production.origin, token: "old-token", id: 1 });
    const transport = new RecordedTransport([{ status: 204 }], { env });
    const pending = authCommand(["logout"], { env, selection: {}, createTransport: () => transport, createBasicAuthTransport: () => transport });
    const replacement = { origin: production.origin, token: "new-token", id: 2 };
    saveToken(env, selected, replacement);
    expect(await pending).toEqual({ auth: "PAT revoked for profile production; replacement credential retained" });
    expect(loadCredentials(env).profiles.production).toEqual(replacement);
  });

  it.each([
    { origin: production.origin, token: "old-token", id: 2 },
    { origin: "https://other.example.com", token: "old-token", id: 1 },
    { origin: production.origin, token: "new-token", id: 1 },
  ])("retains a credential differing from the revoked PAT: %j", (replacement) => {
    const env = environment();
    configure(env, { production: { origin: production.origin } });
    const selected = selectProfile(env);
    saveToken(env, selected, replacement);
    expect(deleteToken(env, selected, { origin: production.origin, token: "old-token", id: 1 })).toBe(false);
    expect(loadCredentials(env).profiles.production).toEqual(replacement);
  });

  it("selects the only profile and resolves its named SecretRef without mixing the env profile", () => {
    const env: Env = { ...environment(), AWX_AXI_TOKEN: "unrelated-token", PRODUCTION_PAT: "profile-token" };
    configure(env, { production });
    env.AWX_AXI_PROFILE = "production";
    expect(resolveCredential(env)).toMatchObject({ token: "profile-token", source: "PRODUCTION_PAT" });
  });

  it("selects flag, env selector, complete env profile, default, then only profile", () => {
    const env = { ...environment(), AWX_AXI_PROFILE: "secondary", AWX_AXI_ORIGIN: "https://env.example.com", AWX_AXI_TOKEN: "env-token" };
    configure(env, { production, secondary: { origin: "https://secondary.example.com" } }, "production");
    expect(selectProfile(env, { profile: "production" }).name).toBe("production");
    expect(selectProfile(env).name).toBe("secondary");
    delete (env as Env).AWX_AXI_PROFILE;
    expect(selectProfile(env).name).toBe("env");
    delete (env as Env).AWX_AXI_ORIGIN;
    delete (env as Env).AWX_AXI_TOKEN;
    expect(selectProfile(env).name).toBe("production");
    configure(env, { secondary: production });
    expect(selectProfile(env).name).toBe("secondary");
  });

  it.each([
    [{}, "PROFILE_REQUIRED"],
    [{ production, secondary: production }, "PROFILE_AMBIGUOUS"],
  ])("rejects unresolved profile selection", (profiles, code) => {
    const env = environment();
    configure(env, profiles);
    expect(() => selectProfile(env)).toThrow(expect.objectContaining({ code }));
  });

  it("refuses partial env profiles instead of falling back to a file profile", () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin };
    configure(env, { production });
    expect(() => selectProfile(env)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it.each(["http://awx.example.com", "https://awx.example.com/api/", "https://user:password@awx.example.com", "https://@awx.example.com", "https://awx.example.com/?query=1", "https://awx.example.com/?", "https://awx.example.com/#fragment", "https://awx.example.com/#", "awx.example.com"]) ("rejects unsafe origin %s", (origin) => {
    expect(() => validateOrigin(origin)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it.each([
    { ...production, token: "inline-secret" },
    { ...production, token: { env: "INVALID-NAME" } },
    { ...production, token: { file: "relative" } },
    { ...production, token: { stored: true, env: "TOKEN" } },
    { ...production, extra: true },
  ])("validates strict profiles and SecretRefs before resolution", (profile) => {
    const env = environment();
    configure(env, { production: profile });
    expect(() => loadConfig(env)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("reads BOM-prefixed file refs and strips trailing whitespace", () => {
    const env = environment();
    const path = join(env.XDG_STATE_HOME!, "pat");
    files.write(path, "\uFEFFfile-token\r\n  ");
    configure(env, { production: { origin: production.origin, token: { file: path } } });
    expect(resolveCredential(env)).toMatchObject({ token: "file-token", source: "file", path });
  });

  it("binds stored tokens to the effective origin, including flag overrides", () => {
    const env = environment();
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    expect(resolveCredential(env)?.token).toBe("bound-token");
    expect(() => resolveCredential(env, { origin: "https://other.example.com" })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
  });

  it("preserves an explicit environment SecretRef after storing a login credential", () => {
    const env = { ...environment(), PRODUCTION_PAT: "environment-token" };
    configure(env, { production });
    const before = readFileSync(configPath(env), "utf8");
    saveToken(env, selectProfile(env), { origin: production.origin, token: "stored-token", id: 9 });
    expect(readFileSync(configPath(env), "utf8")).toBe(before);
    expect(resolveCredential(env)).toMatchObject({ token: "environment-token", source: "PRODUCTION_PAT" });
  });

  it("treats prototype-like profile names as ordinary names", () => {
    const env = environment();
    configure(env, { constructor: { origin: production.origin, token: { stored: true } } });
    expect(resolveCredential(env)).toBeUndefined();
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    expect(resolveCredential(env)?.token).toBe("bound-token");
  });

  it("hard-cuts the legacy token path without reading it", () => {
    const env = environment();
    files.write(join(env.AWX_AXI_HOME!, "token"), "legacy-secret");
    expect(() => loadConfig(env)).toThrow(expect.objectContaining({ code: "CONFIG_MOVED" }));
  });

  it("accepts deprecated aliases with a notice and gives new names precedence", () => {
    const notices: string[] = [];
    const env = normalizeEnv({ CONTROLLER_HOST: production.origin, CONTROLLER_OAUTH_TOKEN: "old-token", AWX_AXI_TOKEN: "new-token" }, (notice) => notices.push(notice));
    expect(env.AWX_AXI_ORIGIN).toBe(production.origin);
    expect(env.AWX_AXI_TOKEN).toBe("new-token");
    expect(notices).toHaveLength(2);
    expect(notices.join()).not.toContain("old-token");
  });

  it("uses Windows app directories and ignores XDG", () => {
    expect(toolDirectory("config", { APPDATA: "C:\\Users\\Example\\Roaming", XDG_CONFIG_HOME: "/ignored" }, "win32", "C:\\Users\\Example")).toBe("C:\\Users\\Example\\Roaming\\awx-axi");
    expect(toolDirectory("state", { LOCALAPPDATA: "C:\\Users\\Example\\Local" }, "win32", "C:\\Users\\Example")).toBe("C:\\Users\\Example\\Local\\awx-axi");
  });

  it.each(["\\\\server\\share\\pat", "\\\\?\\C:\\pat", "C:relative", "\\rooted\\pat"])("rejects nonlocal Windows SecretRef path %s", (file) => {
    expect(() => validateRef({ file }, "win32")).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("accepts absolute Windows drive SecretRefs", () => {
    expect(validateRef({ file: "C:\\private\\pat" }, "win32")).toEqual({ file: "C:\\private\\pat" });
  });

  it.each(["yes", "TRUEE", "", "2"])("rejects invalid boolean %s", (value) => {
    expect(() => booleanEnv({ AWX_AXI_READ_ONLY: value }, "AWX_AXI_READ_ONLY")).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("keeps insecure TLS scoped to the transport", () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_VERIFY_SSL: "false", AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    expect(resolveController(env, {}, true).verifySsl).toBe(false);
    expect(createBasicAuthTransport(env)).toBeDefined();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });
});

describe("authentication through the CLI", () => {
  it.each([
    [{ env: { origin: production.origin } }, {}, "https://other.example.com", []],
    [{ production }, { env: { origin: production.origin, token: "original-token", id: 9 } }, "https://other.example.com", []],
    [{ env: { origin: production.origin } }, { env: { origin: production.origin, token: "original-token", id: 9 } }, "https://other.example.com", []],
    [{ env: { origin: production.origin } }, {}, production.origin, ["--origin", "https://other.example.com"]],
  ] as const)("refuses implicit env login collisions before minting: %j", async (profiles, credentials, origin, argv) => {
    const env = { ...environment(), AWX_AXI_ORIGIN: origin, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    configure(env, profiles);
    files.write(credentialsPath(env), JSON.stringify({ version: 1, profiles: credentials }));
    const beforeConfig = readFileSync(configPath(env), "utf8");
    const beforeCredentials = readFileSync(credentialsPath(env), "utf8");
    const run = await runCli(["auth", "login", ...argv], { env });
    expect(run.stdout).toContain("CONFIG_INVALID");
    expect(run.stdout).toContain("--profile");
    expect(run.transport.requests).toHaveLength(0);
    expect(readFileSync(configPath(env), "utf8")).toBe(beforeConfig);
    expect(readFileSync(credentialsPath(env), "utf8")).toBe(beforeCredentials);
  });

  it("allows implicit env login to replace a PAT bound to the same controller", async () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    configure(env, { env: { origin: production.origin } });
    saveToken(env, selectProfile(env, { profile: "env" }), { origin: production.origin, token: "original-token", id: 9 });
    const before = readFileSync(configPath(env), "utf8");
    const run = await runCli(["auth", "login"], { env, script: [{ status: 201, body: { token: "replacement-token", id: 10 } }] });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(configPath(env), "utf8")).toBe(before);
    expect(resolveCredential(env, { profile: "env" })?.token).toBe("replacement-token");
  });

  it.each([
    [["--profile", "env"], undefined],
    [[], "env"],
  ] as const)("uses the explicitly selected env profile for login: %j", async (argv, profile) => {
    const env = { ...environment(), AWX_AXI_ORIGIN: "https://other.example.com", AWX_AXI_PROFILE: profile, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    configure(env, { env: { origin: production.origin } });
    const run = await runCli(["auth", "login", ...argv], { env, script: [{ status: 201, body: { token: "explicit-token", id: 9 } }] });
    expect(run.exitCode).toBe(0);
    expect(resolveCredential(env, { profile: "env" })?.token).toBe("explicit-token");
  });

  it.each([
    [["template", "launch", "12"], "credential-passwords-file", secretInputs, passwordPreflight, 1],
    [["job", "launch", "12"], "credential-passwords-file", secretInputs, passwordPreflight, 1],
    [["user", "create", "example"], "password-file", commandSecret, [], 2],
    [["user", "edit", "3"], "password-file", commandSecret, [], 2],
    [["credential", "create", "example", "--credential-type", "2"], "inputs-file", secretInputs, [], 2],
    [["credential", "edit", "3"], "inputs-file", secretInputs, [], 2],
    [["team", "credential-create", "3", "--name", "example", "--credential-type", "2"], "inputs-file", secretInputs, [], 2],
    [["notification-template", "create", "example", "--organization", "2", "--notification-type", "webhook"], "configuration-file", secretInputs, [], 2],
    [["notification-template", "edit", "3"], "config-file", secretInputs, [], 2],
    [["notification-template", "edit", "3"], "messages-file", secretInputs, [], 2],
  ] as const)("redacts command secrets echoed in errors for %j", async (argv, flag, content, preflight, exitCode) => {
    const env: Env = { ...environment(), AWX_AXI_ALLOW_SECURITY_WRITES: "1", AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS: "true" };
    const path = join(env.XDG_STATE_HOME!, "input");
    files.write(path, content);
    const run = await runCli([...argv, `--${flag}`, path, "--confirm"], {
      env, script: [...preflight, { status: 400, body: { detail: `denied ${commandSecret} ${JSON.stringify(commandSecret)} ${encodeURIComponent(commandSecret)}` } }],
    });
    expect(run.exitCode).toBe(exitCode);
    expect(run.stdout).toContain("denied");
    expect(run.stdout).toContain("***");
    expect(run.stdout).not.toContain(commandSecret);
    expect(run.stdout).not.toContain(JSON.stringify(commandSecret).slice(1, -1));
    expect(run.stdout).not.toContain(encodeURIComponent(commandSecret));
  });

  it("redacts a user password echoed in successful output", async () => {
    const env: Env = { ...environment(), AWX_AXI_ALLOW_SECURITY_WRITES: "1" };
    const path = join(env.XDG_STATE_HOME!, "password");
    files.write(path, commandSecret);
    const run = await runCli(["user", "edit", "3", "--password-file", path, "--confirm"], {
      env, script: [{ status: 200, body: { username: `echo ${commandSecret}` } }],
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("echo ***");
    expect(run.stdout).not.toContain(commandSecret);
    expect(run.transport.requests[0]?.body).toMatchObject({ password: commandSecret });
  });

  it.each([
    ["{", 0o600, "CONFIG_INVALID"],
    [JSON.stringify({ version: 1, profiles: {} }), 0o640, "CONFIG_INSECURE"],
  ])("rejects an invalid credential store before minting: %s", async (content, mode, code) => {
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    files.write(credentialsPath(env), content);
    chmodSync(credentialsPath(env), mode);
    const run = await runCli(["auth", "login"], { env });
    expect(run.stdout).toContain(code);
    expect(run.transport.requests).toHaveLength(0);
    expect(readFileSync(credentialsPath(env), "utf8")).toBe(content);
  });

  it("reads and writes profiles and credentials beneath symlinked XDG directories", () => {
    const env = environment();
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    const configLink = `${env.XDG_CONFIG_HOME!}-link`;
    const stateLink = `${env.XDG_STATE_HOME!}-link`;
    symlinkSync(env.XDG_CONFIG_HOME!, configLink);
    symlinkSync(env.XDG_STATE_HOME!, stateLink);
    const linked = { ...env, XDG_CONFIG_HOME: configLink, XDG_STATE_HOME: stateLink };
    expect(resolveCredential(linked)?.token).toBe("bound-token");
    saveToken(linked, selectProfile(linked), { origin: production.origin, token: "replacement-token", id: 10 });
    expect(resolveCredential(env)?.token).toBe("replacement-token");
  });

  it("mints a PAT into state without creating config or printing the secret", async () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    const run = await runCli(["auth", "login"], { env, script: [{ status: 201, body: { id: 9, token: "minted-token", scope: "write" } }] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[0]).toMatchObject({ method: "POST", route: "tokens/" });
    expect(run.stdout).not.toContain("minted-token");
    expect(existsSync(configPath(env))).toBe(false);
    expect(run.stdout).toContain("Add profile env");
    configure(env, { env: { origin: production.origin } });
    expect(resolveCredential(env, { profile: "env" })?.token).toBe("minted-token");
  });

  it("refuses login in read-only mode before minting or storing", async () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password", AWX_AXI_READ_ONLY: "true" };
    const run = await runCli(["auth", "login"], { env });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("READ_ONLY_VIOLATION");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("keeps config unchanged and uses stored credentials when the token ref is omitted", async () => {
    const env = { ...environment(), AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    configure(env, { hosted: { origin: production.origin } });
    const before = readFileSync(configPath(env), "utf8");
    const run = await runCli(["auth", "login"], { env, script: [{ status: 201, body: { id: 9, token: "hosted-token" } }] });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(configPath(env), "utf8")).toBe(before);
    expect(resolveCredential(env)?.token).toBe("hosted-token");
  });

  it("rejects login-only env credentials for status before any request", async () => {
    const env = { ...environment(), AWX_AXI_ORIGIN: production.origin, AWX_AXI_USERNAME: "operator", AWX_AXI_PASSWORD: "test-password" };
    const run = await runCli(["auth", "status"], { env });
    expect(run.stdout).toContain("CONFIG_INVALID");
    expect(run.transport.requests).toHaveLength(0);
  });

  it.each(["template", "job"])("%s launch accepts true for credential password authorization", async (domain) => {
    const env: Env = { ...environment(), AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS: "TrUe" };
    const path = join(env.XDG_STATE_HOME!, "passwords.json");
    files.write(path, JSON.stringify({ ssh_password: "synthetic-password" }));
    const run = await runCli([domain, "launch", "12", "--credential-passwords-file", path, "--confirm"], {
      env, script: [{ status: 200, body: { passwords_needed_to_start: ["ssh_password"] } }, { status: 201, body: { id: 7, status: "pending" } }],
    });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests[1]?.body).toMatchObject({ credential_passwords: { ssh_password: "synthetic-password" } });
  });

  it.each(["template", "job"])("%s launch rejects malformed password authorization before launching", async (domain) => {
    const env = { ...environment(), AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS: "yes" };
    const run = await runCli([domain, "launch", "12", "--confirm"], {
      env, script: [{ status: 200, body: { passwords_needed_to_start: ["ssh_password"] } }],
    });
    expect(run.stdout).toContain("CONFIG_INVALID");
    expect(run.transport.requests).toHaveLength(1);
  });

  it.each([
    ["0", "1", "DELETE_WRITES_DISABLED"],
    ["1", "0", "SECURITY_WRITES_DISABLED"],
  ])("retains the stored PAT when logout gates are %s and %s", async (deletes, security, code) => {
    const env = { ...environment(), AWX_AXI_ALLOW_DELETES: deletes, AWX_AXI_ALLOW_SECURITY_WRITES: security };
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    const run = await runCli(["auth", "logout"], { env });
    expect(run.stdout).toContain(code);
    expect(run.transport.requests).toHaveLength(0);
    expect(resolveCredential(env)?.token).toBe("bound-token");
  });

  it("reports the selected profile, source and cheap identity", async () => {
    const env = { ...environment(), PRODUCTION_PAT: "profile-token" };
    configure(env, { production });
    const run = await runCli(["auth", "status"], { env, script: [{ status: 200, body: { results: [{ username: "operator" }] } }] });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("profile: production");
    expect(run.stdout).toContain("source: PRODUCTION_PAT");
    expect(run.stdout).toContain("user: operator");
    expect(run.stdout).not.toContain("profile-token");
  });

  it("redacts resolved secrets and their encoded forms in upstream errors", async () => {
    const token = "synthetic-token/with-encoding";
    const env = { ...environment(), AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_SECURITY_WRITES: "1" };
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token, id: 9 });
    const run = await runCli(["auth", "logout"], { env, script: [{ status: 403, body: { detail: `denied ${token} ${encodeURIComponent(token)}` } }] });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).not.toContain(token);
    expect(run.stdout).not.toContain(encodeURIComponent(token));
    expect(run.stdout).toContain("***");
  });

  it("doctor makes one bounded identity read for the selected profile", async () => {
    const env = { ...environment(), PRODUCTION_PAT: "profile-token" };
    configure(env, { production });
    const run = await runCli(["doctor"], { env, script: [{ status: 200, body: { username: "operator" } }] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toMatchObject([{ method: "GET", route: "me/" }]);
  });

  it("revokes the stored PAT before deleting it locally", async () => {
    const env = { ...environment(), AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_SECURITY_WRITES: "1" };
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    const run = await runCli(["auth", "logout"], { env, script: [{ status: 204 }] });
    expect(run.exitCode).toBe(0);
    expect(run.transport.requests).toMatchObject([{ method: "DELETE", route: "tokens/9/" }]);
    expect(resolveCredential(env)).toBeUndefined();
  });

  it("keeps the local PAT when revocation fails", async () => {
    const env = { ...environment(), AWX_AXI_ALLOW_DELETES: "1", AWX_AXI_ALLOW_SECURITY_WRITES: "1" };
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    const run = await runCli(["auth", "logout"], { env, script: [{ status: 403 }] });
    expect(run.exitCode).toBe(1);
    expect(resolveCredential(env)?.token).toBe("bound-token");
  });

  it("keeps the local PAT when read-only mode refuses logout", async () => {
    const env = { ...environment(), AWX_AXI_READ_ONLY: "true", AWX_AXI_ALLOW_DELETES: "1" };
    configure(env, { production: { origin: production.origin } });
    saveToken(env, selectProfile(env), { origin: production.origin, token: "bound-token", id: 9 });
    const run = await runCli(["auth", "logout"], { env });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("READ_ONLY_VIOLATION");
    expect(run.transport.requests).toHaveLength(0);
    expect(resolveCredential(env)?.token).toBe("bound-token");
  });

  it("refuses to read an insecure config before any request", async () => {
    const env = environment();
    configure(env, { production });
    chmodSync(configPath(env), 0o666);
    const run = await runCli(["auth", "status"], { env });
    expect(run.stdout).toContain("CONFIG_INSECURE");
    expect(run.transport.requests).toHaveLength(0);
  });

  it("refuses a symlink SecretRef before reading its target", () => {
    const env = environment();
    const path = join(env.XDG_STATE_HOME!, "pat");
    files.write(path, "file-token");
    symlinkSync(path, `${path}.link`);
    configure(env, { production: { origin: production.origin, token: { file: `${path}.link` } } });
    expect(() => resolveCredential(env)).toThrow(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  });

  it("config path honors the flag over the environment", async () => {
    const env = environment();
    const path = join(env.XDG_CONFIG_HOME!, "custom.json");
    const run = await runCli(["config", "path", "--config", path], { env });
    expect(run.stdout).toContain(path);
  });

  it("profile list never resolves or prints secrets", async () => {
    const env = environment();
    configure(env, { production });
    const run = await runCli(["profile", "list"], { env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("production");
    expect(run.transport.requests).toHaveLength(0);
    expect(readFileSync(configPath(env), "utf8")).not.toContain("profile-token");
  });
});
