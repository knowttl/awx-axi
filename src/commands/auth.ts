/**
 * `auth login|status|logout` (design.md §5.2, §5.3).
 *
 * Non-interactive by construction: every value comes from the environment, and
 * nothing prompts (AXI §6). The token value is never echoed to stdout, not even
 * truncated.
 */
import { AxiError } from "axi-sdk-js";

import {
  removeTokenFile,
  resolveBasicAuth,
  resolveController,
  resolveCredential,
  tokenFilePath,
  writeTokenFile,
  type Env,
} from "../core/auth.js";
import { errorForResponse, validationError } from "../core/errors.js";
import { parseFlags } from "../core/flags.js";
import type { Renderable } from "../core/registry.js";
import type { AwxTransport } from "../core/transport.js";

export interface AuthContext {
  readonly env: Env;
  createTransport(): AwxTransport;
  /** Basic auth, used by `auth login` alone (§5.1). */
  createBasicAuthTransport(): AwxTransport;
}

export const AUTH_HELP = `auth: authenticate against the controller
usage: awx-axi auth login|status|logout

  login    mint a token from CONTROLLER_USERNAME and CONTROLLER_PASSWORD and store it 0600
  status   report whether a credential resolved, and who it belongs to
  logout   remove the stored token file

No secret is ever a command-line argument: credentials come from the
environment or from the 0600 token file (design.md §5.3).

examples:
  awx-axi auth login
  awx-axi auth status
  awx-axi auth logout
`;

const SUBCOMMANDS = ["login", "status", "logout"];

export async function authCommand(
  args: string[],
  context: AuthContext,
): Promise<Renderable> {
  const name = args[0];
  if (name === undefined || !SUBCOMMANDS.includes(name)) {
    throw validationError(
      name === undefined
        ? "`awx-axi auth` needs a subcommand"
        : `unknown subcommand \`auth ${name}\``,
      [`valid subcommands for \`awx-axi auth\`: ${SUBCOMMANDS.join(", ")}`],
    );
  }

  parseFlags(`auth ${name}`, args.slice(1), []);

  switch (name) {
    case "login":
      return login(context);
    case "logout":
      return logout(context.env);
    default:
      return status(context);
  }
}

async function login(context: AuthContext): Promise<Renderable> {
  const config = resolveController(context.env);
  const basic = resolveBasicAuth(context.env);

  // Validate the required input before calling any dependency (AXI §6). §5.2
  // requires exit 2 here and names the missing variables: this is missing
  // required input, which §9.1 codes as VALIDATION_ERROR, not the
  // AUTH_REQUIRED that means "no credential resolved" on an ordinary command.
  if (basic === undefined) {
    const missing = [
      ...(context.env.CONTROLLER_USERNAME ? [] : ["CONTROLLER_USERNAME"]),
      ...(context.env.CONTROLLER_PASSWORD ? [] : ["CONTROLLER_PASSWORD"]),
    ];
    throw validationError(
      `\`auth login\` needs ${missing.join(" and ")} in the environment`,
      [
        "Set them in the environment and re-run `awx-axi auth login`",
        "Or set CONTROLLER_OAUTH_TOKEN to an existing token and skip login",
      ],
    );
  }

  const transport = context.createBasicAuthTransport();

  const response = await transport.post("/api/v2/tokens/", {
    description: "awx-axi",
    scope: "write",
  });

  if (response.status === 403) {
    throw new AxiError(
      `${config.host} refused to mint a token for this account`,
      "FORBIDDEN",
      [
        "An SSO-provisioned account cannot mint a token unless the controller enables it",
        "Set CONTROLLER_OAUTH_TOKEN to a token issued through the controller UI instead",
      ],
    );
  }
  if (response.status !== 201) {
    throw errorForResponse(response, { subject: `${config.host}` });
  }

  const body = (response.body ?? {}) as Record<string, unknown>;
  const token = body.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new AxiError(
      `${config.host} returned no token`,
      "UNKNOWN",
      ["Run `awx-axi auth status` to check the stored credential"],
    );
  }

  const path = tokenFilePath(context.env);
  writeTokenFile(path, token);

  return {
    auth: {
      controller: config.host,
      user: usernameOf(body) ?? basic?.username ?? "unknown",
      token: `stored in ${collapseHome(path, context.env)}`,
      scope: typeof body.scope === "string" ? body.scope : "write",
    },
  };
}

async function status(context: AuthContext): Promise<Renderable> {
  const config = resolveController(context.env);
  const credential = resolveCredential(context.env);

  if (credential === undefined) {
    return {
      auth: {
        controller: config.host,
        source: "none",
        valid: false,
      },
      help: [
        "Run `awx-axi auth login` with CONTROLLER_USERNAME and CONTROLLER_PASSWORD set",
        "Or set CONTROLLER_OAUTH_TOKEN to an existing token",
      ],
    };
  }

  const source =
    credential.path === undefined
      ? credential.source
      : collapseHome(credential.path, context.env);
  const response = await context.createTransport().get("/api/v2/me/");
  const valid = response.status === 200;

  return {
    auth: {
      controller: config.host,
      source,
      user: valid ? (firstResultUsername(response.body) ?? "unknown") : "unknown",
      valid,
    },
    ...(valid
      ? {}
      : {
          help: [
            "Run `awx-axi auth login` to mint a fresh token",
          ],
        }),
  };
}

function logout(env: Env): Renderable {
  const path = tokenFilePath(env);
  const removed = removeTokenFile(path);

  return {
    auth: removed
      ? `token removed from ${collapseHome(path, env)}`
      : `no stored token at ${collapseHome(path, env)} (no-op)`,
  };
}

function usernameOf(body: Record<string, unknown>): string | undefined {
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const user = (summary.user ?? {}) as Record<string, unknown>;
  return typeof user.username === "string" ? user.username : undefined;
}

function firstResultUsername(body: unknown): string | undefined {
  const results = (body as { results?: unknown } | null)?.results;
  const row = Array.isArray(results) ? results[0] : body;
  const username = (row as { username?: unknown } | null)?.username;
  return typeof username === "string" ? username : undefined;
}

function collapseHome(path: string, env: Env): string {
  const home = env.HOME;
  return home !== undefined && home.length > 0 && path.startsWith(home)
    ? `~${path.slice(home.length)}`
    : path;
}
