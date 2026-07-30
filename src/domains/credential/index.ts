/**
 * The `credential` domain: list and inspect AWX credentials (design.md v1 roadmap).
 */
import { errorForResponse, validationError } from "../../core/errors.js";
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
import { resolveId } from "../../core/resolve.js";

const DEFAULT_LIST_LIMIT = 100;

const LIST_SCHEMA = {
  label: "credentials",
  defaultFields: ["id", "name", "organization", "credential_type", "managed"],
  fieldAllowlist: ["description", "kind", "cloud", "kubernetes", "created", "modified"],
} as const;

function positiveLimit(
  raw: string | true | undefined,
  fallback: number,
  subcommand: string,
): number {
  if (raw === true) {
    throw validationError(
      `--limit needs a value for \`credential ${subcommand}\`, got --limit`,
      [`Run \`awx-axi credential ${subcommand} --limit ${fallback}\``],
    );
  }
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--limit must be a positive integer for \`credential ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi credential ${subcommand} --limit ${fallback}\``],
    );
  }
  return value;
}

function parseOrganization(raw: string | undefined, subcommand: string): number {
  if (raw === undefined) {
    throw validationError(`--organization needs a positive integer for \`credential ${subcommand}\``);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      `--organization must be a positive integer for \`credential ${subcommand}\`, got ${raw}`,
      [`Run \`awx-axi credential ${subcommand} --organization <id>\``],
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

function toCredentialRow(raw: unknown): Row {
  const record = (raw ?? {}) as Record<string, unknown>;
  const summary = (record.summary_fields ?? {}) as Record<string, unknown>;

  return {
    id: typeof record.id === "number" ? record.id : 0,
    name: typeof record.name === "string" ? record.name : "",
    organization: summarizeReference(summary.organization),
    credential_type: summarizeReference(summary.credential_type),
    managed: record.managed === true ? "managed" : "unmanaged",
  };
}

function* listPlan(input: SubcommandInput): Plan<DomainResult> {
  const limit = positiveLimit(input.flags.limit, DEFAULT_LIST_LIMIT, "list");
  const query: Record<string, string | number | boolean> = {};

  if (typeof input.flags.search === "string") {
    query.search = input.flags.search;
  }
  if (typeof input.flags.organization === "string") {
    query.organization = parseOrganization(input.flags.organization, "list");
  }

  const paged = yield* readPaged("credentials/", query, limit);
  const rows = paged.rows.map(toCredentialRow);

  return listOutput({
    label: LIST_SCHEMA.label,
    rows,
    count: paged.count,
    empty: "0 credentials found",
    help: [
      "Run `awx-axi credential show <id|name>` to inspect one credential",
      `Run \`awx-axi credential list --organization <id>\` to scope by organization`,
    ],
  });
}

function* showPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "credentials/",
    noun: "credential",
    listCommand: "credential list",
    command: "credential show",
  });

  const detail = yield* read(`credentials/${id}/`);
  if (detail.status !== 200) {
    throw errorForResponse(detail, { subject: `credential ${id}` });
  }

  const body = (detail.body ?? {}) as Record<string, unknown>;
  const summary = (body.summary_fields ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "credential",
    fields: {
      id,
      name: body.name ?? null,
      organization: summarizeReference(summary.organization),
      credential_type: summarizeReference(summary.credential_type),
      kind: body.kind ?? null,
      managed: body.managed === true ? "managed" : "unmanaged",
      description: body.description ?? null,
      created: body.created ?? null,
      modified: body.modified ?? null,
    },
    help: [
      `Run ` +
        "`awx-axi credential list --organization <id>` to find credentials by organization",
    ],
  });
}

export const credentialDomain: Domain = defineDomain({
  name: "credential",
  help: [
    "credential: AWX credentials and their metadata",
    "",
    "Subcommands:",
    "  list  [--search <s>] [--organization <id>] [--limit <n>]",
    "  show  <id|name>",
  ].join("\n"),
  mcpEquivalents: ["list_credentials"],
  subcommands: [
    {
      name: "list",
      help: "awx-axi credential list [--search <s>] [--organization <id>] [--limit <n>]",
      flags: [
        { name: "search", description: "search credentials", takesValue: true },
        {
          name: "organization",
          description: "filter credentials by organization id",
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
          suggestions: ["Run `awx-axi credential show <id|name>` for detail"],
        },
      ],
      plan: listPlan,
    },
    {
      name: "show",
      help: "awx-axi credential show <id|name>",
      flags: [],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: {
        label: "credential",
        defaultFields: [],
        fieldAllowlist: [],
      },
      suggestions: [],
      plan: showPlan,
    },
  ],
});
