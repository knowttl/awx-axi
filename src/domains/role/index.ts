/**
 * The `role` domain: list, show, grant, and revoke AWX RBAC roles, hierarchy, and subject assignments.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
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
import { resolveId } from "../../core/resolve.js";

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "roles",
  defaultFields: ["id", "name", "type", "resource_name"],
  fieldAllowlist: ["description", "resource_type", "created", "modified"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`role ${subcommand}\`, got --limit`,
      [`Run \`awx-axi role ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`role ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi role ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function summarizeReference(raw: unknown): string | null {
  const record = (raw ?? {}) as Record<string, unknown>;
  const id = typeof record.id === "number" ? record.id : null;
  const name = typeof record.name === "string" ? record.name : null;

  return id === null || name === null ? null : `${id} (${name})`;
}

function relatedCount(summary: unknown, key: string): number | null {
  if (summary === undefined || summary === null || typeof summary !== "object") {
    return null;
  }
  const values = (summary as Record<string, unknown>)[key];
  return typeof values === "number" ? values : null;
}

function toRoleListRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;
  const resourceName =
    typeof summary.resource_name === "string"
      ? summary.resource_name
      : typeof record.resource_name === "string"
        ? record.resource_name
        : null;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    type: typeof record.type === "string" ? record.type : "",
    resource_name: resourceName,
  };
}

function toRoleRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    type: typeof record.type === "string" ? record.type : "",
    description: typeof record.description === "string" ? record.description : "",
  };
}

function toUserRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    username: typeof record.username === "string" ? record.username : "",
    first_name: typeof record.first_name === "string" ? record.first_name : "",
    last_name: typeof record.last_name === "string" ? record.last_name : "",
    email: typeof record.email === "string" ? record.email : null,
  };
}

function toTeamRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    organization: summarizeReference(summary.organization),
    description: typeof record.description === "string" ? record.description : "",
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.type === "string") {
    query.type = input.flags.type;
  }

  const paged = yield* readPaged("roles/", query, limit);
  const rows = paged.rows.map(toRoleListRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 roles found",
    help: [
      "Run `awx-axi role show <id|name>` to inspect one role",
      "Run `awx-axi role list --type <t>` to filter by role type",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role show",
  });

  const detail = yield* read(`roles/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `role ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const counts = (summary.related_field_counts ?? {}) as Record<string, unknown>;

  const resourceName =
    typeof summary.resource_name === "string"
      ? summary.resource_name
      : typeof body.resource_name === "string"
        ? body.resource_name
        : null;

  const resourceType =
    typeof summary.resource_type === "string"
      ? summary.resource_type
      : typeof body.resource_type === "string"
        ? body.resource_type
        : null;

  const resourceId =
    typeof summary.resource_id === "number"
      ? summary.resource_id
      : typeof body.resource_id === "number"
        ? body.resource_id
        : null;

  return detailOutput({
    label: "role",
    fields: {
      id,
      name: body.name ?? null,
      type: body.type ?? null,
      description: body.description ?? null,
      resource_name: resourceName,
      resource_type: resourceType,
      resource_id: resourceId,
      parents: relatedCount(counts, "parents"),
      children: relatedCount(counts, "children"),
      users: relatedCount(counts, "users"),
      teams: relatedCount(counts, "teams"),
      created: body.created ?? null,
      modified: body.modified ?? null,
    },
    help: [
      `Run \`awx-axi role parents ${id}\` for parent roles`,
      `Run \`awx-axi role users ${id}\` for users holding this role`,
    ],
  });
}

function* parentsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role parents",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "parents");
  const paged = yield* readPaged(`roles/${id}/parents/`, {}, limit);
  const rows = paged.rows.map(toRoleRow);

  return listOutput({
    label: "parents",
    rows,
    count: paged.count,
    empty: "0 parent roles found",
    help: [`Run \`awx-axi role show <id|name>\` to inspect role detail`],
  });
}

function* childrenPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role children",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "children");
  const paged = yield* readPaged(`roles/${id}/children/`, {}, limit);
  const rows = paged.rows.map(toRoleRow);

  return listOutput({
    label: "children",
    rows,
    count: paged.count,
    empty: "0 child roles found",
    help: [`Run \`awx-axi role show <id|name>\` to inspect role detail`],
  });
}

function* usersPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role users",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "users");
  const paged = yield* readPaged(`roles/${id}/users/`, {}, limit);
  const rows = paged.rows.map(toUserRow);

  return listOutput({
    label: "users",
    rows,
    count: paged.count,
    empty: "0 users found holding role",
    help: [`Run \`awx-axi user show <id|name>\` to inspect user detail`],
  });
}

function* teamsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role teams",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "teams");
  const paged = yield* readPaged(`roles/${id}/teams/`, {}, limit);
  const rows = paged.rows.map(toTeamRow);

  return listOutput({
    label: "teams",
    rows,
    count: paged.count,
    empty: "0 teams found holding role",
    help: [`Run \`awx-axi team show <id|name>\` to inspect team detail`],
  });
}

function* resolveUserSubject(value: string, command: string): Plan<number> {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const response = yield* read("users/", { username: value });
  if (response.status !== 200) {
    throw errorForResponse(response, { subject: `user "${value}"` });
  }

  const envelope = (response.body ?? {}) as { results?: unknown };
  const matches = Array.isArray(envelope.results)
    ? (envelope.results as Record<string, unknown>[])
    : [];

  if (matches.length === 1 && typeof matches[0]?.id === "number") {
    return matches[0].id;
  }

  if (matches.length === 0) {
    const iexactRes = yield* read("users/", { username__iexact: value });
    if (iexactRes.status === 200) {
      const iexactEnvelope = (iexactRes.body ?? {}) as { results?: unknown };
      const iexactMatches = Array.isArray(iexactEnvelope.results)
        ? (iexactEnvelope.results as Record<string, unknown>[])
        : [];
      if (iexactMatches.length === 1 && typeof iexactMatches[0]?.id === "number") {
        return iexactMatches[0].id;
      }
    }

    throw validationError(`no user is named "${value}"`, [
      `Run \`awx-axi user list --search "${value}"\` to search users`,
    ]);
  }

  throw validationError(`multiple users match "${value}"`, [
    `Re-run with the user id, e.g. \`awx-axi ${command} --user <id>\``,
  ]);
}

function* grantRolePlan(input: SubcommandInput): Plan<DomainResult> {
  const roleId = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role grant",
  });

  const hasUser = typeof input.flags.user === "string";
  const hasTeam = typeof input.flags.team === "string";

  if (!hasUser && !hasTeam) {
    throw validationError("`role grant` needs --user or --team", [
      "Provide a user or team, e.g. `awx-axi role grant <role> --user <username>`",
    ]);
  }

  let route: string;
  let targetType: "user" | "team";
  let targetId: number;
  let payload: Record<string, unknown>;

  if (hasUser) {
    targetType = "user";
    targetId = yield* resolveUserSubject(input.flags.user as string, "role grant");
    route = `roles/${roleId}/users/`;
    payload = { id: targetId };
  } else {
    targetType = "team";
    targetId = yield* resolveId(input.flags.team as string, {
      listRoute: "teams/",
      noun: "team",
      listCommand: "team list",
      command: "role grant",
    });
    route = `roles/${roleId}/teams/`;
    payload = { id: targetId };
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "grant",
        role: roleId,
        [targetType]: targetId,
        would_send: `POST ${route}`,
        payload,
      },
      help: ["Re-run with --confirm to grant role"],
    });
  }

  const res = yield* write(route, payload, { method: "POST", tag: "security" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 201) {
    throw errorForResponse(res, { subject: `role ${roleId}` });
  }

  return detailOutput({
    label: "role_grant",
    fields: {
      role: roleId,
      [targetType]: targetId,
      status: "granted",
    },
  });
}

function* revokeRolePlan(input: SubcommandInput): Plan<DomainResult> {
  const roleId = yield* resolveId(input.args[0] ?? "", {
    listRoute: "roles/",
    noun: "role",
    listCommand: "role list",
    command: "role revoke",
  });

  const hasUser = typeof input.flags.user === "string";
  const hasTeam = typeof input.flags.team === "string";

  if (!hasUser && !hasTeam) {
    throw validationError("`role revoke` needs --user or --team", [
      "Provide a user or team, e.g. `awx-axi role revoke <role> --user <username>`",
    ]);
  }

  let route: string;
  let targetType: "user" | "team";
  let targetId: number;
  let payload: Record<string, unknown>;

  if (hasUser) {
    targetType = "user";
    targetId = yield* resolveUserSubject(input.flags.user as string, "role revoke");
    route = `roles/${roleId}/users/`;
    payload = { id: targetId, disassociate: true };
  } else {
    targetType = "team";
    targetId = yield* resolveId(input.flags.team as string, {
      listRoute: "teams/",
      noun: "team",
      listCommand: "team list",
      command: "role revoke",
    });
    route = `roles/${roleId}/teams/`;
    payload = { id: targetId, disassociate: true };
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "revoke",
        role: roleId,
        [targetType]: targetId,
        would_send: `POST ${route}`,
        payload,
      },
      help: ["Re-run with --confirm to revoke role"],
    });
  }

  const res = yield* write(route, payload, { method: "POST", tag: "security" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 201) {
    throw errorForResponse(res, { subject: `role ${roleId}` });
  }

  return detailOutput({
    label: "role_revoke",
    fields: {
      role: roleId,
      [targetType]: targetId,
      status: "revoked",
    },
  });
}

export const roleDomain: Domain = defineDomain({
  name: "role",
  help: [
    "role: AWX RBAC roles and permissions hierarchy",
    "",
    "Subcommands:",
    "  grant     <id|name> [--user <id|username>] [--team <id|name>] [--confirm] [--dry-run]",
    "  revoke    <id|name> [--user <id|username>] [--team <id|name>] [--confirm] [--dry-run]",
    "  list      [--search <s>] [--type <t>] [--limit <n>]",
    "  show      <id|name>",
    "  parents   <id|name> [--limit <n>]",
    "  children  <id|name> [--limit <n>]",
    "  users     <id|name> [--limit <n>]",
    "  teams     <id|name> [--limit <n>]",
  ].join("\n"),
  mcpEquivalents: [
    "list_roles",
    "get_role",
    "grant_role",
    "revoke_role",
    "list_role_parents",
    "list_role_children",
    "list_role_users",
    "list_role_teams",
  ],
  subcommands: [
    {
      name: "grant",
      help: "awx-axi role grant <id|name> [--user <id|username>] [--team <id|name>] [--confirm] [--dry-run]",
      flags: [
        { name: "user", description: "user id or username", takesValue: true },
        { name: "team", description: "team id or name", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "role", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: grantRolePlan,
    },
    {
      name: "revoke",
      help: "awx-axi role revoke <id|name> [--user <id|username>] [--team <id|name>] [--confirm] [--dry-run]",
      flags: [
        { name: "user", description: "user id or username", takesValue: true },
        { name: "team", description: "team id or name", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "role", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: revokeRolePlan,
    },
    {
      name: "list",
      help: "awx-axi role list [--search <s>] [--type <t>] [--limit <n>]",
      flags: [
        { name: "search", description: "search roles", takesValue: true },
        { name: "type", description: "filter roles by type", takesValue: true },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi role show <id|name>` for detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi role show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "role", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "parents",
      help: "awx-axi role parents <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "parents",
        defaultFields: ["id", "name", "type", "description"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: parentsPlan,
    },
    {
      name: "children",
      help: "awx-axi role children <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "children",
        defaultFields: ["id", "name", "type", "description"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: childrenPlan,
    },
    {
      name: "users",
      help: "awx-axi role users <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "users",
        defaultFields: ["id", "username", "first_name", "last_name", "email"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: usersPlan,
    },
    {
      name: "teams",
      help: "awx-axi role teams <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "teams",
        defaultFields: ["id", "name", "organization", "description"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: teamsPlan,
    },
  ],
});
