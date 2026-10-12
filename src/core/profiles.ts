import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

import { AxiError } from "axi-sdk-js";

import { PrivateFiles } from "./private-file.js";
import { registerSecret } from "./redact.js";

export type Env = Record<string, string | undefined>;
export type SecretRef = { env: string } | { file: string } | { stored: true };
export interface Profile {
  origin: string;
  verifySsl?: boolean;
  token?: SecretRef;
}
export interface ProfileConfig {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}
export interface Selection {
  configPath?: string;
  profile?: string;
  origin?: string;
  verifySsl?: boolean;
}
export interface SelectedProfile {
  name: string;
  profile: Profile;
  config: ProfileConfig;
  path: string;
}
export interface StoredToken { origin: string; token: string; id: number }
interface Credentials { version: 1; profiles: Record<string, StoredToken> }

export function invalid(message: string): never {
  throw new AxiError(message, "CONFIG_INVALID");
}

export function booleanEnv(env: Env, name: string, fallback = false): boolean {
  const value = env[name]?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return invalid(`${name} must be 1, true, 0 or false`);
}

/** One-release vendor aliases, normalized before profile selection. */
export function normalizeEnv(env: Env, notice: (message: string) => void = (message) => process.stderr.write(`${message}\n`)): Env {
  const normalized = { ...env };
  for (const [legacy, current] of Object.entries({
    CONTROLLER_HOST: "AWX_AXI_ORIGIN",
    CONTROLLER_OAUTH_TOKEN: "AWX_AXI_TOKEN",
    CONTROLLER_USERNAME: "AWX_AXI_USERNAME",
    CONTROLLER_PASSWORD: "AWX_AXI_PASSWORD",
    CONTROLLER_VERIFY_SSL: "AWX_AXI_VERIFY_SSL",
  })) {
    if (env[legacy] !== undefined) {
      notice(`${legacy} is deprecated; use ${current}`);
      normalized[current] ??= env[legacy];
      delete normalized[legacy];
    }
  }
  return normalized;
}

export function toolDirectory(kind: "config" | "state", env: Env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === "win32") {
    const base = env[kind === "config" ? "APPDATA" : "LOCALAPPDATA"];
    return win32.join(base && win32.isAbsolute(base) ? base : win32.join(home, "AppData", kind === "config" ? "Roaming" : "Local"), "awx-axi");
  }
  const xdg = env[kind === "config" ? "XDG_CONFIG_HOME" : "XDG_STATE_HOME"];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, kind === "config" ? ".config" : ".local/state"), "awx-axi");
}

export function configPath(env: Env, selection: Selection = {}): string {
  return selection.configPath ?? env.AWX_AXI_CONFIG ?? join(toolDirectory("config", env), "config.json");
}

export function credentialsPath(env: Env): string {
  return join(toolDirectory("state", env), "credentials.json");
}

export function writeLogPath(env: Env): string {
  return env.AWX_AXI_WRITE_LOG ?? join(toolDirectory("state", env), "writes.log");
}

export function validateOrigin(value: unknown): string {
  if (typeof value !== "string") return invalid("origin must be an HTTPS origin");
  if (!/^https:\/\/[^/\\\s@?#]+\/?$/i.test(value)) {
    return invalid("origin must use https:// with no path, userinfo, query or fragment; plain HTTP controllers are refused");
  }
  let url: URL;
  try { url = new URL(value); } catch { return invalid("origin must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return invalid("origin must use https:// with no path, userinfo, query or fragment; plain HTTP controllers are refused");
  }
  return url.origin;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains an unknown field`);
}

export function validateRef(value: unknown, platform: NodeJS.Platform = process.platform): SecretRef {
  const ref = record(value, "token SecretRef (inline secrets are forbidden)");
  if (Object.keys(ref).length !== 1) return invalid("token must contain exactly one SecretRef key");
  if (typeof ref.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env)) return { env: ref.env };
  if (typeof ref.file === "string") {
    const absolute = platform === "win32"
      ? /^[A-Za-z]:[\\/]/.test(ref.file) && !ref.file.startsWith("\\\\")
      : isAbsolute(ref.file);
    if (absolute) return { file: ref.file };
  }
  if (ref.stored === true) return { stored: true };
  return invalid("token must be an env, absolute file, or stored SecretRef");
}

function profileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) invalid("invalid profile name");
}

export function loadConfig(env: Env, selection: Selection = {}, files = new PrivateFiles(), verifyAcl = false): ProfileConfig {
  const path = configPath(env, selection);
  const raw = files.read(path, false, verifyAcl);
  if (raw === undefined) {
    const legacy = join(env.AWX_AXI_HOME ?? join(homedir(), ".awx-axi"), "token");
    if (existsSync(legacy)) {
      throw new AxiError(`configuration moved from ${legacy} to ${path}`, "CONFIG_MOVED", [
        `Create ${path} using the profile/SecretRef format at https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md; run auth login to create origin-bound state credentials`,
      ]);
    }
    return { version: 1, profiles: {} };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return invalid(`invalid JSON in ${path}`); }
  const data = record(parsed, "config");
  keys(data, ["version", "defaultProfile", "profiles"], "config");
  if (data.version !== 1) return invalid("config version must be 1");
  const profiles: Record<string, Profile> = Object.create(null) as Record<string, Profile>;
  for (const [name, value] of Object.entries(record(data.profiles, "profiles"))) {
    profileName(name);
    const input = record(value, "profile");
    keys(input, ["origin", "verifySsl", "token"], "profile");
    if (input.verifySsl !== undefined && typeof input.verifySsl !== "boolean") invalid("verifySsl must be a boolean");
    profiles[name] = {
      origin: validateOrigin(input.origin),
      ...(input.verifySsl === undefined ? {} : { verifySsl: input.verifySsl as boolean }),
      ...(input.token === undefined ? {} : { token: validateRef(input.token) }),
    };
  }
  if (data.defaultProfile !== undefined && (typeof data.defaultProfile !== "string" || !Object.hasOwn(profiles, data.defaultProfile))) {
    return invalid("defaultProfile must name a configured profile");
  }
  return { version: 1, profiles, ...(data.defaultProfile === undefined ? {} : { defaultProfile: data.defaultProfile as string }) };
}

export function selectProfile(envInput: Env, selection: Selection = {}, files = new PrivateFiles(), verifyAcl = false, login = false): SelectedProfile {
  const env = normalizeEnv(envInput);
  const config = loadConfig(env, selection, files, verifyAcl);
  const path = configPath(env, selection);
  let name = selection.profile ?? env.AWX_AXI_PROFILE;
  let profile: Profile;
  if (name !== undefined) {
    profileName(name);
    if (!Object.hasOwn(config.profiles, name)) throw new AxiError("selected profile was not found", "PROFILE_NOT_FOUND");
    profile = config.profiles[name]!;
  } else if (env.AWX_AXI_ORIGIN !== undefined) {
    if (!env.AWX_AXI_TOKEN && !(login && env.AWX_AXI_USERNAME && env.AWX_AXI_PASSWORD)) {
      invalid("env profile is incomplete: AWX_AXI_ORIGIN requires AWX_AXI_TOKEN (or login credentials for auth login)");
    }
    name = "env";
    profile = { origin: validateOrigin(env.AWX_AXI_ORIGIN), verifySsl: booleanEnv(env, "AWX_AXI_VERIFY_SSL", true), token: { env: "AWX_AXI_TOKEN" } };
  } else {
    if (env.AWX_AXI_TOKEN !== undefined || env.AWX_AXI_VERIFY_SSL !== undefined) invalid("env profile is incomplete: AWX_AXI_ORIGIN is required");
    const names = Object.keys(config.profiles);
    name = config.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
    if (name === undefined) throw new AxiError("select a configured profile with --profile or AWX_AXI_PROFILE", names.length ? "PROFILE_AMBIGUOUS" : "PROFILE_REQUIRED");
    profile = config.profiles[name]!;
  }
  return { name, config, path, profile: { ...profile,
    ...(selection.origin === undefined ? {} : { origin: validateOrigin(selection.origin) }),
    ...(selection.verifySsl === undefined ? {} : { verifySsl: selection.verifySsl }),
  } };
}

export function loadCredentials(env: Env, files = new PrivateFiles(), verifyAcl = false): Credentials {
  return files.withLock(credentialsPath(env), () => readCredentials(env, files, verifyAcl));
}

function readCredentials(env: Env, files: PrivateFiles, verifyAcl = false): Credentials {
  const raw = files.read(credentialsPath(env), true, verifyAcl);
  if (raw === undefined) return { version: 1, profiles: Object.create(null) as Record<string, StoredToken> };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return invalid("invalid credentials JSON"); }
  const input = record(parsed, "credentials");
  keys(input, ["version", "profiles"], "credentials");
  if (input.version !== 1) invalid("credentials version must be 1");
  const profiles: Record<string, StoredToken> = Object.create(null) as Record<string, StoredToken>;
  for (const [name, rawToken] of Object.entries(record(input.profiles, "stored profiles"))) {
    profileName(name);
    const token = record(rawToken, "stored token");
    keys(token, ["origin", "token", "id"], "stored token");
    if (typeof token.token !== "string" || !token.token || !Number.isSafeInteger(token.id) || (token.id as number) <= 0) invalid("invalid stored token");
    profiles[name] = { origin: validateOrigin(token.origin), token: token.token as string, id: token.id as number };
  }
  return { version: 1, profiles };
}

export function storedToken(env: Env, selected: SelectedProfile, files = new PrivateFiles(), verifyAcl = false): StoredToken | undefined {
  const stored = loadCredentials(env, files, verifyAcl).profiles[selected.name];
  if (stored && stored.origin !== selected.profile.origin) invalid("stored token origin does not match the selected profile; restore the original origin or log in again");
  if (stored) registerSecret(stored.token);
  return stored;
}

export function saveToken(env: Env, selected: SelectedProfile, token: StoredToken, files = new PrivateFiles(), implicit = false): void {
  files.withLock(credentialsPath(env), () => {
    const credentials = readCredentials(env, files);
    const current = credentials.profiles[selected.name];
    if (implicit && current && current.origin !== token.origin) {
      invalid("environment login would replace an env profile bound to another controller; select a configured profile explicitly with --profile or AWX_AXI_PROFILE");
    }
    credentials.profiles[selected.name] = token;
    files.write(credentialsPath(env), `${JSON.stringify(credentials, null, 2)}\n`);
  });
}

export function deleteToken(env: Env, selected: SelectedProfile, revoked: StoredToken, files = new PrivateFiles()): boolean {
  let removed = true;
  files.withLock(credentialsPath(env), () => {
    const credentials = readCredentials(env, files);
    const current = credentials.profiles[selected.name];
    if (current && (current.id !== revoked.id || current.origin !== revoked.origin || current.token !== revoked.token)) {
      removed = false;
      return;
    }
    delete credentials.profiles[selected.name];
    files.write(credentialsPath(env), `${JSON.stringify(credentials, null, 2)}\n`);
  });
  return removed;
}
