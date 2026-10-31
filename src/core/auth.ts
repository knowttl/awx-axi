import { AxiError } from "axi-sdk-js";
import type { ResponseDiagnostics } from "../response-diagnostics.js";

import { readControllerMetadata } from "./controller-discovery.js";
import { PrivateFiles } from "./private-file.js";
import { credentialsPath, normalizeEnv, selectProfile, storedToken, type Env, type Selection } from "./profiles.js";
import { registerSecret } from "./redact.js";
import { HttpTransport, isReadOnly, type AwxTransport } from "./transport.js";

export type { Env } from "./profiles.js";

export interface ControllerConfig {
  readonly host: string;
  readonly baseUrl: string;
  readonly verifySsl: boolean;
  readonly apiBasePath: string;
}
export interface Credential {
  readonly token: string;
  readonly source: string;
  readonly path?: string;
}

export function resolveController(env: Env, selection: Selection = {}, login = false): ControllerConfig {
  const { profile } = selectProfile(env, selection, undefined, false, login);
  if (profile.origin.startsWith("http://")) process.stderr.write("warning: plain HTTP controller traffic, including credentials, is unencrypted\n");
  const path = env.AWX_AXI_API_BASE_PATH ?? readControllerMetadata(profile.origin, env)?.apiBasePath ?? "/api/v2/";
  if (!/^\/[^?#]*$/.test(path) || path.startsWith("//")) throw new AxiError("AWX_AXI_API_BASE_PATH must be an absolute API path", "CONFIG_INVALID");
  return {
    host: new URL(profile.origin).host,
    baseUrl: profile.origin,
    verifySsl: profile.verifySsl ?? true,
    apiBasePath: path.endsWith("/") ? path : `${path}/`,
  };
}

export function resolveCredential(envInput: Env, selection: Selection = {}, files = new PrivateFiles(), verifyAcl = false): Credential | undefined {
  const env = normalizeEnv(envInput);
  const selected = selectProfile(env, selection, files, verifyAcl);
  const ref = selected.profile.token ?? { stored: true };
  let token: string | undefined;
  let source: string;
  let path: string | undefined;
  if ("env" in ref) {
    token = env[ref.env];
    source = ref.env;
  } else if ("file" in ref) {
    token = files.read(ref.file, true, verifyAcl)?.replace(/^\uFEFF/, "").trimEnd();
    source = "file";
    path = ref.file;
  } else {
    token = storedToken(env, selected, files, verifyAcl)?.token;
    source = "stored";
    path = credentialsPath(env);
  }
  if (!token) return undefined;
  registerSecret(token);
  return { token, source, ...(path === undefined ? {} : { path }) };
}

export function requireCredential(env: Env, selection: Selection = {}): Credential {
  const credential = resolveCredential(env, selection);
  if (credential === undefined) throw new AxiError("no credential is configured", "AUTH_REQUIRED", [
    "Run `awx-axi auth login` with AWX_AXI_USERNAME and AWX_AXI_PASSWORD set",
    "Or configure a token SecretRef",
  ]);
  return credential;
}

export interface BasicAuth { readonly username: string; readonly password: string }

export function resolveBasicAuth(envInput: Env): BasicAuth | undefined {
  const env = normalizeEnv(envInput);
  const username = env.AWX_AXI_USERNAME;
  const password = env.AWX_AXI_PASSWORD;
  if (!username || !password) return undefined;
  registerSecret(password);
  registerSecret(Buffer.from(`${username}:${password}`).toString("base64"));
  return { username, password };
}

export function createTransport(env: Env, selection: Selection = {}, override?: Credential, signal?: AbortSignal, diagnostics?: ResponseDiagnostics): AwxTransport {
  const config = resolveController(env, selection);
  const credential = override ?? requireCredential(env, selection);
  registerSecret(credential.token);
  return new HttpTransport({
    baseUrl: config.baseUrl, apiBasePath: config.apiBasePath,
    verifySsl: config.verifySsl, authorization: `Bearer ${credential.token}`,
    readOnly: isReadOnly(env), env,
    ...(signal === undefined ? {} : { signal }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

export function createBasicAuthTransport(env: Env, selection: Selection = {}, diagnostics?: ResponseDiagnostics): AwxTransport {
  const config = resolveController(env, selection, true);
  const basic = resolveBasicAuth(env);
  if (!basic) throw new AxiError("AWX_AXI_USERNAME and AWX_AXI_PASSWORD are required to mint a token", "AUTH_REQUIRED");
  return new HttpTransport({
    baseUrl: config.baseUrl, apiBasePath: config.apiBasePath,
    verifySsl: config.verifySsl,
    authorization: `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString("base64")}`,
    readOnly: isReadOnly(env), env,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}
