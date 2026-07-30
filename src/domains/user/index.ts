/**
 * The `user` domain: list and inspect AWX users (design.md §14.2 roadmap).
 */
import { AwxAxiError, errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput, listOutput, type Row } from "../../core/output.js";
import {
  defineDomain,
  read,
  readPaged,
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

export const userDomain: Domain = defineDomain({
  name: "user",
  help: [
    "user: AWX users and identity metadata",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_users", "get_user"],
  subcommands: [
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
