/**
 * Credential resolution and token minting (design.md §5).
 *
 * awx-axi reads the same `CONTROLLER_*` environment variables awxkit uses
 * (§3.5), so an operator who already configured the official CLI needs no new
 * setup. Secrets arrive through the environment or through a `0600` file and
 * never through `argv` (§5.3).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AxiError } from "axi-sdk-js";

import { HttpTransport, isReadOnly, type AwxTransport } from "./transport.js";

export type Env = Record<string, string | undefined>;

export interface ControllerConfig {
  /** Hostname alone, for output: no scheme, no path. */
  readonly host: string;
  readonly baseUrl: string;
  readonly verifySsl: boolean;
  /** `/api/v2/` at 24.6.1; a gateway-fronted controller moves it (§4.2). */
  readonly apiBasePath: string;
}

/** Where a resolved credential came from, reported by `auth status` (§5.3). */
export type CredentialSource = "CONTROLLER_OAUTH_TOKEN" | "token file";

export interface Credential {
  readonly token: string;
  readonly source: CredentialSource;
  /** The token file path, when that is where the token came from. */
  readonly path?: string;
}

export function resolveController(env: Env): ControllerConfig {
  const host = env.CONTROLLER_HOST;
  if (host === undefined || host.trim().length === 0) {
    throw new AxiError(
      "no controller is configured",
      "AUTH_REQUIRED",
      ["Set CONTROLLER_HOST to the controller URL, e.g. https://awx.example.com"],
    );
  }

  const baseUrl = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return {
    host: new URL(baseUrl).host,
    baseUrl,
    verifySsl: env.CONTROLLER_VERIFY_SSL !== "false",
    apiBasePath: env.AWX_AXI_API_BASE_PATH ?? "/api/v2/",
  };
}

/** `$AWX_AXI_HOME/token`, default `~/.awx-axi/token` (§5.1). */
export function tokenFilePath(env: Env): string {
  return join(env.AWX_AXI_HOME ?? join(homedir(), ".awx-axi"), "token");
}

/**
 * Resolution order (§5.1): the environment token, then the token file, then
 * nothing.
 *
 * Basic auth is **never** used for ordinary requests even when
 * `CONTROLLER_USERNAME` and `CONTROLLER_PASSWORD` are set. It is used by
 * `auth login` alone, to mint a token, which keeps the password out of the
 * request path of every other command.
 */
export function resolveCredential(env: Env): Credential | undefined {
  const fromEnv = env.CONTROLLER_OAUTH_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { token: fromEnv.trim(), source: "CONTROLLER_OAUTH_TOKEN" };
  }

  const path = tokenFilePath(env);
  const stored = readTokenFile(path);
  if (stored !== undefined) {
    return { token: stored, source: "token file", path };
  }

  return undefined;
}

export function requireCredential(env: Env): Credential {
  const credential = resolveCredential(env);
  if (credential === undefined) {
    throw new AxiError("no credential is configured", "AUTH_REQUIRED", [
      "Run `awx-axi auth login` with CONTROLLER_USERNAME and CONTROLLER_PASSWORD set",
      "Or set CONTROLLER_OAUTH_TOKEN to an existing token",
    ]);
  }
  return credential;
}

export interface BasicAuth {
  readonly username: string;
  readonly password: string;
}

/** The `auth login` credential, and nothing else's (§5.1). */
export function resolveBasicAuth(env: Env): BasicAuth | undefined {
  const username = env.CONTROLLER_USERNAME;
  const password = env.CONTROLLER_PASSWORD;
  return username !== undefined &&
    username.length > 0 &&
    password !== undefined &&
    password.length > 0
    ? { username, password }
    : undefined;
}

export function readTokenFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Write the token file at `0600`. Its value is never echoed (§5.2). */
export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function removeTokenFile(path: string): boolean {
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  rmSync(path);
  return true;
}

/**
 * The bearer-token transport every ordinary command uses.
 *
 * `CONTROLLER_VERIFY_SSL=false` is applied here rather than in the transport
 * because Node's native `fetch` takes no per-request TLS options and awx-axi
 * declines a second HTTP dependency to get them (§12).
 */
export function createTransport(env: Env): AwxTransport {
  const config = resolveController(env);
  const credential = requireCredential(env);
  applyTlsPosture(config, env);

  return new HttpTransport({
    baseUrl: config.baseUrl,
    authorization: `Bearer ${credential.token}`,
    readOnly: isReadOnly(env),
  });
}

/** The basic-auth transport, used only by `auth login` to mint a token (§5.1). */
export function createBasicAuthTransport(env: Env): AwxTransport {
  const config = resolveController(env);
  const basic = resolveBasicAuth(env);
  if (basic === undefined) {
    throw new AxiError(
      "CONTROLLER_USERNAME and CONTROLLER_PASSWORD are required to mint a token",
      "AUTH_REQUIRED",
      [
        "Set CONTROLLER_USERNAME and CONTROLLER_PASSWORD in the environment, then re-run `awx-axi auth login`",
      ],
    );
  }
  applyTlsPosture(config, env);

  const encoded = Buffer.from(`${basic.username}:${basic.password}`).toString(
    "base64",
  );
  return new HttpTransport({
    baseUrl: config.baseUrl,
    authorization: `Basic ${encoded}`,
    readOnly: isReadOnly(env),
  });
}

function applyTlsPosture(config: ControllerConfig, env: Env): void {
  if (!config.verifySsl && env === process.env) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}
