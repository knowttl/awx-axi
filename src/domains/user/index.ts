/**
 * The `user` domain: list and inspect AWX users (design.md §14.2 roadmap).
 */
import { readFileSync, statSync } from "node:fs";

import { AwxAxiError, errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
import {
  defineDomain,
  read,
  readPaged,
  write,
  type Domain,
  type DomainResult,
  type Plan,
  type SubcommandInput,
} from "../../core/registry.js";

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "users",
  defaultFields: [
    "id",
    "username",
    "first_name",
    "last_name",
    "email",
    "is_superuser",
    "is_system_auditor",
  ],
  fieldAllowlist: ["auth", "external_account", "last_login", "created", "modified"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`user ${subcommand}\`, got --limit`,
      [`Run \`awx-axi user ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`user ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi user ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

interface UserMatch {
  readonly id: number;
  readonly name: string;
  readonly organization: string;
}

interface UsernameMatchPage {
  readonly matches: readonly UserMatch[];
  readonly count: number | undefined;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toUserRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    username: typeof record.username === "string" ? record.username : "",
    first_name: typeof record.first_name === "string" ? record.first_name : "",
    last_name: typeof record.last_name === "string" ? record.last_name : "",
    email: typeof record.email === "string" ? record.email : null,
    is_superuser: toBoolean(record.is_superuser),
    is_system_auditor: toBoolean(record.is_system_auditor),
  };
}

function toMatch(raw: unknown): UserMatch {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const org = (summary.organization ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.username === "string" ? record.username : "",
    organization:
      typeof org.name === "string"
        ? org.name
        : "",
  };
}

function* resolveUserId(input: string): Plan<number> {
  if (/^\d+$/.test(input)) {
    return Number(input);
  }

  let page = yield* matchByUsernamePlan(input, "username");
  if (page.matches.length === 0) {
    page = yield* matchByUsernamePlan(input, "username__iexact");
  }

  const matches = page.matches;
  if (matches.length === 0) {
    throw new AwxAxiError(
      `no user is named "${input}"`,
      "NAME_NOT_FOUND",
      [
        `Run \`awx-axi user list --search "${input}"\` to search by partial name`,
        `A user this account cannot see looks identical to one that does not exist`,
      ],
    );
  }
  const first = matches[0]!;
  if (matches.length === 1) {
    return first.id;
  }

  const total = page.count ?? matches.length;
  const partial = total > matches.length;

  throw new AwxAxiError(
    `${total} users are named "${input}"`,
    "AMBIGUOUS_NAME",
    [
      `Re-run with the id, e.g. \`awx-axi user show ${first.id}\``,
      ...(partial
        ? [
            `Only ${matches.length} of the ${total} candidates are listed above; run \`awx-axi user list --search "${input}"\` for the rest`,
          ]
        : []),
    ],
    { candidates: matches },
  );
}

function* matchByUsernamePlan(
  value: string,
  lookup: "username" | "username__iexact",
): Plan<UsernameMatchPage> {
  const response = yield* read("users/", { [lookup]: value });
  if (response.status !== 200) {
    throw errorForResponse(response, {
      subject: `user "${value}"`,
    });
  }

  const envelope = (response.body ?? {}) as { results?: unknown; count?: unknown };
  return {
    matches: Array.isArray(envelope.results)
      ? envelope.results.map(toMatch)
      : [],
    count: typeof envelope.count === "number" ? envelope.count : undefined,
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }

  const paged = yield* readPaged("users/", query, limit);
  const rows = paged.rows.map(toUserRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 users found",
    help: ["Run `awx-axi user show <id|name>` to inspect one user"],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveUserId(input.args[0] ?? "");

  const detail = yield* read(`users/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `user ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const createdBy = (summary.created_by ?? {}) as Record<string, unknown>;
  const modifiedBy = (summary.modified_by ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "user",
    fields: {
      id,
      username: body.username ?? null,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      email: body.email ?? null,
      is_superuser: toBoolean(body.is_superuser),
      is_system_auditor: toBoolean(body.is_system_auditor),
      external_account: toBoolean(body.external_account),
      last_login: body.last_login ?? null,
      created_by:
        typeof createdBy.id === "number" && typeof createdBy.name === "string"
          ? `${createdBy.id} (${createdBy.name})`
          : null,
      modified_by:
        typeof modifiedBy.id === "number" && typeof modifiedBy.name === "string"
          ? `${modifiedBy.id} (${modifiedBy.name})`
          : null,
      created: body.created ?? null,
      modified: body.modified ?? null,
    },
    help: ["Run `awx-axi user list` to find users by partial username"],
  });
}

function readSecretContent(filePath: string): string {
  if (filePath === "-") {
    return readFileSync(0, "utf8");
  }
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw validationError(`secret file "${filePath}" could not be read`);
  }

  if ((stats.mode & 0o077) !== 0) {
    throw validationError(
      `secret file "${filePath}" is group- or world-readable; permissions must be 0600`,
    );
  }

  return readFileSync(filePath, "utf8");
}

function parseUserPassword(input: SubcommandInput): string | undefined {
  if (typeof input.flags["password-file"] === "string") {
    return readSecretContent(input.flags["password-file"]).trim();
  }
  return undefined;
}

function* createUserPlan(input: SubcommandInput): Plan<DomainResult> {
  const username =
    input.args[0] ??
    (typeof input.flags.username === "string" ? input.flags.username : undefined);

  if (username === undefined) {
    throw validationError("`user create` needs a username argument or --username", [
      "Provide a username, e.g. `awx-axi user create alice --password-file /path/to/pass`",
    ]);
  }

  const password = parseUserPassword(input);

  const payload: Record<string, unknown> = { username };
  if (password !== undefined) payload.password = password;
  if (typeof input.flags["first-name"] === "string") payload.first_name = input.flags["first-name"];
  if (typeof input.flags["last-name"] === "string") payload.last_name = input.flags["last-name"];
  if (typeof input.flags.email === "string") payload.email = input.flags.email;
  if (input.flags["is-superuser"] === true) payload.is_superuser = true;
  if (input.flags["is-system-auditor"] === true) payload.is_system_auditor = true;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    const dryPayload = { ...payload };
    if (dryPayload.password !== undefined) {
      dryPayload.password = "[redacted]";
    }
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "user",
        username,
        would_send: "POST users/",
        payload: dryPayload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("users/", payload, { method: "POST", tag: "security" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `user ${username}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "user",
    fields: {
      id,
      username: body.username ?? username,
    },
    help: [`Run \`awx-axi user show ${id}\` to inspect user`],
  });
}

function* editUserPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveUserId(input.args[0] ?? "");

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.username === "string") payload.username = input.flags.username;
  if (typeof input.flags["first-name"] === "string") payload.first_name = input.flags["first-name"];
  if (typeof input.flags["last-name"] === "string") payload.last_name = input.flags["last-name"];
  if (typeof input.flags.email === "string") payload.email = input.flags.email;
  if (input.flags["is-superuser"] === true) payload.is_superuser = true;
  if (input.flags["no-superuser"] === true) payload.is_superuser = false;
  if (input.flags["is-system-auditor"] === true) payload.is_system_auditor = true;
  if (input.flags["no-system-auditor"] === true) payload.is_system_auditor = false;

  const password = parseUserPassword(input);
  if (password !== undefined) payload.password = password;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    const dryPayload = { ...payload };
    if (dryPayload.password !== undefined) {
      dryPayload.password = "[redacted]";
    }
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        user: id,
        would_send: `PATCH users/${id}/`,
        payload: dryPayload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`users/${id}/`, payload, { method: "PATCH", tag: "security" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `user ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "user",
    fields: {
      id,
      username: body.username ?? null,
    },
    help: [`Run \`awx-axi user show ${id}\` to inspect updated user`],
  });
}

function* deleteUserPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveUserId(input.args[0] ?? "");

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        user: id,
        would_send: `DELETE users/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`users/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `user ${id}` });
  }

  return detailOutput({
    label: "user",
    fields: {
      id,
      status: "deleted",
    },
  });
}

export const userDomain: Domain = defineDomain({
  name: "user",
  help: [
    "user: AWX users and identity metadata",
    "",
    "Subcommands:",
    "  create  [<username>] [--password-file <p>] [--confirm] [--dry-run]",
    "  edit    <id|name> [--username <u>] [--password-file <p>] [--confirm] [--dry-run]",
    "  delete  <id|name> [--confirm] [--dry-run]",
    "  list    [--search <s>] [--limit <n>]",
    "  show    <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_users",
    "get_user",
    "create_user",
    "update_user",
    "delete_user",
  ],
  subcommands: [
    {
      name: "create",
      help: "awx-axi user create [<username>] [--password-file <p>] [--confirm] [--dry-run]",
      flags: [
        { name: "username", description: "username", takesValue: true },
        { name: "password-file", description: "password file path (or - for stdin)", takesValue: true },
        { name: "first-name", description: "first name", takesValue: true },
        { name: "last-name", description: "last name", takesValue: true },
        { name: "email", description: "email address", takesValue: true },
        { name: "is-superuser", description: "make superuser", takesValue: false },
        { name: "is-system-auditor", description: "make system auditor", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<username>"], required: 0 },
      schema: { label: "user", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createUserPlan,
    },
    {
      name: "edit",
      help: "awx-axi user edit <id|name> [--username <u>] [--password-file <p>] [--confirm] [--dry-run]",
      flags: [
        { name: "username", description: "username", takesValue: true },
        { name: "password-file", description: "password file path (or - for stdin)", takesValue: true },
        { name: "first-name", description: "first name", takesValue: true },
        { name: "last-name", description: "last name", takesValue: true },
        { name: "email", description: "email address", takesValue: true },
        { name: "is-superuser", description: "make superuser", takesValue: false },
        { name: "no-superuser", description: "remove superuser", takesValue: false },
        { name: "is-system-auditor", description: "make system auditor", takesValue: false },
        { name: "no-system-auditor", description: "remove system auditor", takesValue: false },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "user", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editUserPlan,
    },
    {
      name: "delete",
      help: "awx-axi user delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "user", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteUserPlan,
    },
    {
      name: "list",
      help: "awx-axi user list [--search <s>] [--limit <n>]",
      flags: [
        { name: "search", description: "search users", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi user show <id|name>` for detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi user show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "user", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
