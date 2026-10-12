import { AxiError } from "axi-sdk-js";

import { resolveBasicAuth, resolveController, resolveCredential, type Credential, type Env } from "../core/auth.js";
import { errorForResponse, validationError } from "../core/errors.js";
import { parseFlags } from "../core/flags.js";
import { credentialsPath, deleteToken, loadCredentials, saveToken, selectProfile, storedToken, type Selection } from "../core/profiles.js";
import { registerSecret } from "../core/redact.js";
import type { Renderable } from "../core/registry.js";
import type { AwxTransport } from "../core/transport.js";
import { assertWritable } from "../core/transport.js";

export interface AuthContext {
  readonly env: Env;
  readonly selection: Selection;
  createTransport(credential?: Credential): AwxTransport;
  createBasicAuthTransport(): AwxTransport;
}

export const AUTH_HELP = `auth: authenticate against the controller
usage: awx-axi auth login|status|logout [--config <path>] [--profile <name>]

  login    mint a PAT using AWX_AXI_USERNAME and AWX_AXI_PASSWORD and store it privately
  status   report selected profile, origin, credential source, and identity
  logout   revoke the stored PAT upstream before deleting it locally

Global non-secret overrides: --origin <https-origin>, --verify-ssl <true|false>.
Secrets come from environment variables or SecretRefs, never arguments.
Logout respects read-only, delete and security gates; set AWX_AXI_ALLOW_DELETES=1 and AWX_AXI_ALLOW_SECURITY_WRITES=1 to revoke.

examples:
  awx-axi auth login --profile production
  awx-axi auth status
  awx-axi auth logout --profile production
`;

export async function authCommand(args: string[], context: AuthContext): Promise<Renderable> {
  const name = args[0];
  if (!name || !["login", "status", "logout"].includes(name)) throw validationError("auth needs login, status, logout");
  parseFlags(`auth ${name}`, args.slice(1), [], { names: [], required: 0 });
  if (name === "login") return login(context);
  if (name === "logout") return logout(context);
  return status(context);
}

async function login(context: AuthContext): Promise<Renderable> {
  const basic = resolveBasicAuth(context.env);
  if (!basic) throw validationError("auth login needs AWX_AXI_USERNAME and AWX_AXI_PASSWORD in the environment");
  const selected = selectProfile(context.env, context.selection, undefined, false, true);
  const credentials = loadCredentials(context.env);
  if (selected.name === "env" && context.selection.profile === undefined && context.env.AWX_AXI_PROFILE === undefined &&
    [selected.config.profiles.env?.origin, credentials.profiles.env?.origin].some((origin) => origin !== undefined && origin !== selected.profile.origin)) {
    throw new AxiError("environment login would replace an env profile bound to another controller; select a configured profile explicitly with --profile or AWX_AXI_PROFILE", "CONFIG_INVALID");
  }
  const response = await context.createBasicAuthTransport().post("tokens/", { description: "awx-axi", scope: "write" });
  if (response.status !== 201) throw errorForResponse(response, { subject: selected.profile.origin });
  const body = (response.body ?? {}) as Record<string, unknown>;
  if (typeof body.token !== "string" || !body.token) throw new AxiError("controller returned no token", "AUTH_REQUIRED");
  registerSecret(body.token);
  if (!Number.isSafeInteger(body.id) || (body.id as number) <= 0) throw new AxiError("controller returned no PAT id; credential was not stored", "AUTH_REQUIRED");
  saveToken(context.env, selected, { origin: selected.profile.origin, token: body.token, id: body.id as number });
  return { auth: { profile: selected.name, origin: selected.profile.origin, user: basic.username, credential: `stored in ${credentialsPath(context.env)}`, scope: body.scope ?? "write" },
    help: [
      ...(Object.hasOwn(selected.config.profiles, selected.name) ? [] : [`Add profile ${selected.name} with origin ${selected.profile.origin} to ${selected.path}; login never writes config`]),
      `Run \`awx-axi auth status --profile ${selected.name}\` to check the configured profile`,
    ] };
}

async function status(context: AuthContext): Promise<Renderable> {
  const selected = selectProfile(context.env, context.selection, undefined, true);
  const config = resolveController(context.env, context.selection);
  const credential = resolveCredential(context.env, context.selection, undefined, true);
  if (!credential) return { auth: { profile: selected.name, origin: selected.profile.origin, controller: config.host, source: "none", valid: false }, help: ["Run `awx-axi auth login` to store a PAT"] };
  const response = await context.createTransport().get("me/");
  const body = response.body as { results?: { username?: string }[]; username?: string } | null;
  return { auth: { profile: selected.name, origin: selected.profile.origin, controller: config.host, source: credential.path ?? credential.source,
    user: response.status === 200 ? (body?.results?.[0]?.username ?? body?.username ?? "unknown") : "unknown", valid: response.status === 200 } };
}

async function logout(context: AuthContext): Promise<Renderable> {
  const selected = selectProfile(context.env, context.selection);
  const stored = storedToken(context.env, selected);
  if (!stored) return { auth: "no stored PAT for the selected profile (no-op)" };
  assertWritable(context.env, "DELETE", `tokens/${stored.id}/`);
  const response = await context.createTransport({ token: stored.token, source: "stored" }).delete(`tokens/${stored.id}/`, "security");
  if (response.status !== 204 && response.status !== 404) throw errorForResponse(response, { subject: "PAT revocation" });
  deleteToken(context.env, selected);
  return { auth: `PAT revoked and removed for profile ${selected.name}` };
}
