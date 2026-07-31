/**
 * The `team` domain: list and inspect AWX teams, membership, and access controls.
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
  label: "teams",
  defaultFields: ["id", "name", "organization", "description"],
  fieldAllowlist: ["created", "modified"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`team ${subcommand}\`, got --limit`,
      [`Run \`awx-axi team ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`team ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi team ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function parseOrganization(
  raw: string | true | undefined,
  subcommand: string,
): number {
  if (raw === true || raw === undefined) {
    throw validationError(
      `--organization needs a positive integer for \`team ${subcommand}\``,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--organization must be a positive integer for \`team ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi team ${subcommand} --organization <id>\``],
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

function toProjectRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    scm_type: typeof record.scm_type === "string" ? record.scm_type : null,
    status: typeof record.status === "string" ? record.status : "",
  };
}

function toCredentialRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    credential_type: summarizeReference(summary.credential_type),
    managed: record.managed === true ? "managed" : "unmanaged",
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

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.organization === "string" || input.flags.organization === true) {
    query.organization = parseOrganization(input.flags.organization, "list");
  }

  const paged = yield* readPaged("teams/", query, limit);
  const rows = paged.rows.map(toTeamRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 teams found",
    help: [
      "Run `awx-axi team show <id|name>` to inspect one team",
      "Run `awx-axi team list --organization <id>` to filter by organization",
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team show",
  });

  const detail = yield* read(`teams/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `team ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;
  const counts = (summary.related_field_counts ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "team",
    fields: {
      id,
      name: body.name ?? null,
      description: body.description ?? null,
      organization: summarizeReference(summary.organization),
      users: relatedCount(counts, "users"),
      projects: relatedCount(counts, "projects"),
      credentials: relatedCount(counts, "credentials"),
      roles: relatedCount(counts, "roles"),
      created_by: summarizeReference(summary.created_by),
      modified_by: summarizeReference(summary.modified_by),
      created: body.created ?? null,
      modified: body.modified ?? null,
    },
    help: [
      `Run \`awx-axi team users ${id}\` to list team members`,
      `Run \`awx-axi team roles ${id}\` to inspect assigned roles`,
    ],
  });
}

function* usersPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team users",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "users");
  const paged = yield* readPaged(`teams/${id}/users/`, {}, limit);
  const rows = paged.rows.map(toUserRow);

  return listOutput({
    label: "users",
    rows,
    count: paged.count,
    empty: "0 users found for team",
    help: [`Run \`awx-axi user show <id|name>\` to inspect user detail`],
  });
}

function* projectsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team projects",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "projects");
  const paged = yield* readPaged(`teams/${id}/projects/`, {}, limit);
  const rows = paged.rows.map(toProjectRow);

  return listOutput({
    label: "projects",
    rows,
    count: paged.count,
    empty: "0 projects found for team",
    help: [`Run \`awx-axi project show <id|name>\` to inspect project detail`],
  });
}

function* credentialsPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team credentials",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "credentials");
  const paged = yield* readPaged(`teams/${id}/credentials/`, {}, limit);
  const rows = paged.rows.map(toCredentialRow);

  return listOutput({
    label: "credentials",
    rows,
    count: paged.count,
    empty: "0 credentials found for team",
    help: [`Run \`awx-axi credential show <id|name>\` to inspect credential detail`],
  });
}

function* rolesPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team roles",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "roles");
  const paged = yield* readPaged(`teams/${id}/roles/`, {}, limit);
  const rows = paged.rows.map(toRoleRow);

  return listOutput({
    label: "roles",
    rows,
    count: paged.count,
    empty: "0 roles found for team",
    help: [`Run \`awx-axi role show <id|name>\` to inspect role detail`],
  });
}

function* objectRolesPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team object-roles",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "object-roles");
  const paged = yield* readPaged(`teams/${id}/object_roles/`, {}, limit);
  const rows = paged.rows.map(toRoleRow);

  return listOutput({
    label: "object_roles",
    rows,
    count: paged.count,
    empty: "0 object roles found for team",
    help: [`Run \`awx-axi role show <id|name>\` to inspect role detail`],
  });
}

function* accessListPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team access-list",
  });

  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "access-list");
  const paged = yield* readPaged(`teams/${id}/access_list/`, {}, limit);
  const rows = paged.rows.map(toUserRow);

  return listOutput({
    label: "access_list",
    rows,
    count: paged.count,
    empty: "0 access list members found for team",
    help: [`Run \`awx-axi user show <id|name>\` to inspect user detail`],
  });
}

function* createTeamPlan(input: SubcommandInput): Plan<DomainResult> {
  const name =
    input.args[0] ??
    (typeof input.flags.name === "string" ? input.flags.name : undefined);

  if (name === undefined) {
    throw validationError("`team create` needs a team name argument or --name", [
      "Provide a name, e.g. `awx-axi team create Engineering --organization Default`",
    ]);
  }

  if (typeof input.flags.organization !== "string") {
    throw validationError("`team create` needs an --organization id or name", [
      "Provide an organization, e.g. `--organization Default`",
    ]);
  }

  const organizationId = yield* resolveId(input.flags.organization, {
    listRoute: "organizations/",
    noun: "organization",
    listCommand: "organization list",
    command: "team create",
  });

  const payload: Record<string, unknown> = {
    name,
    organization: organizationId,
  };
  if (typeof input.flags.description === "string") payload.description = input.flags.description;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "team",
        name,
        would_send: "POST teams/",
        payload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("teams/", payload, { method: "POST", tag: "security" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `team ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "team",
    fields: {
      id,
      name: body.name ?? name,
    },
    help: [`Run \`awx-axi team show ${id}\` to inspect team`],
  });
}

function* editTeamPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.organization === "string") {
    payload.organization = yield* resolveId(input.flags.organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "team edit",
    });
  }
  if (typeof input.flags.description === "string") payload.description = input.flags.description;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        team: id,
        would_send: `PATCH teams/${id}/`,
        payload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`teams/${id}/`, payload, { method: "PATCH", tag: "security" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `team ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "team",
    fields: {
      id,
      name: body.name ?? null,
    },
    help: [`Run \`awx-axi team show ${id}\` to inspect updated team`],
  });
}

function* deleteTeamPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "teams/",
    noun: "team",
    listCommand: "team list",
    command: "team delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        team: id,
        would_send: `DELETE teams/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`teams/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `team ${id}` });
  }

  return detailOutput({
    label: "team",
    fields: {
      id,
      status: "deleted",
    },
  });
}

export const teamDomain: Domain = defineDomain({
  name: "team",
  help: [
    "team: AWX teams, membership, and access controls",
    "",
    "Subcommands:",
    "  create        [<name>] --organization <id|name> [--confirm] [--dry-run]",
    "  edit          <id|name> [--name <n>] [--organization <id|name>] [--confirm] [--dry-run]",
    "  delete        <id|name> [--confirm] [--dry-run]",
    "  list          [--search <s>] [--organization <id>] [--limit <n>]",
    "  show          <id|name>",
    "  users         <id|name> [--limit <n>]",
    "  projects      <id|name> [--limit <n>]",
    "  credentials   <id|name> [--limit <n>]",
    "  roles         <id|name> [--limit <n>]",
    "  object-roles  <id|name> [--limit <n>]",
    "  access-list   <id|name> [--limit <n>]",
  ].join("\n"),
  mcpEquivalents: [
    "list_teams",
    "get_team",
    "create_team",
    "update_team",
    "delete_team",
    "list_team_users",
    "list_team_projects",
    "list_team_credentials",
    "list_team_roles",
    "list_team_object_roles",
    "list_team_access_list",
  ],
  subcommands: [
    {
      name: "create",
      help: "awx-axi team create [<name>] --organization <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "team name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "team", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createTeamPlan,
    },
    {
      name: "edit",
      help: "awx-axi team edit <id|name> [--name <n>] [--organization <id|name>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "team name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "team", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editTeamPlan,
    },
    {
      name: "delete",
      help: "awx-axi team delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "team", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteTeamPlan,
    },
    {
      name: "list",
      help: "awx-axi team list [--search <s>] [--organization <id>] [--limit <n>]",
      flags: [
        { name: "search", description: "search teams", takesValue: true },
        {
          name: "organization",
          description: "filter teams by organization id",
          takesValue: true,
        },
        { name: "limit", description: "rows to return", takesValue: true },
        { name: "fields", description: "extra fields", takesValue: true },
      ],
      positionals: { names: [], required: 0 },
      schema: LIST_SCHEMA,
      suggestions: [
        {
          outcome: "listed",
          suggestions: ["Run `awx-axi team show <id|name>` for detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi team show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "team", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: showPlan,
    },
    {
      name: "users",
      help: "awx-axi team users <id|name> [--limit <n>]",
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
      name: "projects",
      help: "awx-axi team projects <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "projects",
        defaultFields: ["id", "name", "scm_type", "status"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: projectsPlan,
    },
    {
      name: "credentials",
      help: "awx-axi team credentials <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "credentials",
        defaultFields: ["id", "name", "credential_type", "managed"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: credentialsPlan,
    },
    {
      name: "roles",
      help: "awx-axi team roles <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "roles",
        defaultFields: ["id", "name", "type", "description"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: rolesPlan,
    },
    {
      name: "object-roles",
      help: "awx-axi team object-roles <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "object_roles",
        defaultFields: ["id", "name", "type", "description"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: objectRolesPlan,
    },
    {
      name: "access-list",
      help: "awx-axi team access-list <id|name> [--limit <n>]",
      flags: [{ name: "limit", description: "rows to return", takesValue: true }],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "access_list",
        defaultFields: ["id", "username", "first_name", "last_name", "email"],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: accessListPlan,
    },
  ],
});
