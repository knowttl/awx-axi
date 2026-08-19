/**
 * The `credential` domain: list, show, create, edit, and delete AWX credentials.
 */
import { readFileSync, statSync } from "node:fs";

import { errorForResponse, validationError } from "../../core/errors.js";
import { dryRun, isLive } from "../../core/mutations.js";
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

function parseInputs(input: SubcommandInput): Record<string, unknown> {
  if (typeof input.flags["inputs-file"] !== "string") {
    return {};
  }
  const content = readSecretContent(input.flags["inputs-file"]);

  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fail
  }
  throw validationError("credential inputs must be a JSON object");
}

function* createCredentialPlan(input: SubcommandInput): Plan<DomainResult> {
  const name =
    input.args[0] ??
    (typeof input.flags.name === "string" ? input.flags.name : undefined);

  if (name === undefined) {
    throw validationError(
      "`credential create` needs a credential name argument or --name",
      [
        "Provide a name, e.g. `awx-axi credential create \"Production AWS\" --credential-type Amazon`",
      ],
    );
  }

  if (typeof input.flags["credential-type"] !== "string") {
    throw validationError(
      "`credential create` needs a --credential-type id or name",
      ["Provide a credential type, e.g. `--credential-type \"Amazon Web Services\"`"],
    );
  }

  const credentialTypeId = yield* resolveId(input.flags["credential-type"], {
    listRoute: "credential_types/",
    noun: "credential type",
    listCommand: "credential list",
    command: "credential create",
  });

  let organizationId: number | undefined;
  if (typeof input.flags.organization === "string") {
    organizationId = yield* resolveId(input.flags.organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "credential create",
    });
  }

  const inputs = parseInputs(input);

  const payload: Record<string, unknown> = {
    name,
    credential_type: credentialTypeId,
    inputs,
  };
  if (organizationId !== undefined) payload.organization = organizationId;
  if (typeof input.flags.description === "string") payload.description = input.flags.description;

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    const dryPayload = {
      ...payload,
      inputs: Object.fromEntries(Object.keys(inputs).map((k) => [k, "[redacted]"])),
    };
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "create",
        type: "credential",
        name,
        would_send: "POST credentials/",
        payload: dryPayload,
      },
      help: ["Re-run with --confirm to create"],
    });
  }

  const res = yield* write("credentials/", payload, { method: "POST", tag: "security" });
  if (res.status !== 201 && res.status !== 200) {
    throw errorForResponse(res, { subject: `credential ${name}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "number" ? body.id : 0;

  return detailOutput({
    label: "credential",
    fields: {
      id,
      name: body.name ?? name,
    },
    help: [`Run \`awx-axi credential show ${id}\` to inspect credential`],
  });
}

function* editCredentialPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "credentials/",
    noun: "credential",
    listCommand: "credential list",
    command: "credential edit",
  });

  const payload: Record<string, unknown> = {};
  if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (typeof input.flags.organization === "string") {
    payload.organization = yield* resolveId(input.flags.organization, {
      listRoute: "organizations/",
      noun: "organization",
      listCommand: "organization list",
      command: "credential edit",
    });
  }
  if (typeof input.flags["credential-type"] === "string") {
    payload.credential_type = yield* resolveId(input.flags["credential-type"], {
      listRoute: "credential_types/",
      noun: "credential type",
      listCommand: "credential list",
      command: "credential edit",
    });
  }
  if (typeof input.flags.description === "string") payload.description = input.flags.description;

  const hasInputs = typeof input.flags["inputs-file"] === "string";
  if (hasInputs) {
    payload.inputs = parseInputs(input);
  }

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    const dryPayload = { ...payload };
    if (typeof dryPayload.inputs === "object" && dryPayload.inputs !== null) {
      dryPayload.inputs = Object.fromEntries(
        Object.keys(dryPayload.inputs as Record<string, unknown>).map((k) => [k, "[redacted]"]),
      );
    }
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "edit",
        credential: id,
        would_send: `PATCH credentials/${id}/`,
        payload: dryPayload,
      },
      help: ["Re-run with --confirm to edit"],
    });
  }

  const res = yield* write(`credentials/${id}/`, payload, { method: "PATCH", tag: "security" });
  if (res.status !== 200) {
    throw errorForResponse(res, { subject: `credential ${id}` });
  }

  const body = (res.body ?? {}) as Record<string, unknown>;

  return detailOutput({
    label: "credential",
    fields: {
      id,
      name: body.name ?? null,
    },
    help: [`Run \`awx-axi credential show ${id}\` to inspect updated credential`],
  });
}

function* copyCredentialPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", { listRoute: "credentials/", noun: "credential", listCommand: "credential list", command: "credential copy" });
  const payload: Record<string, unknown> = {}; if (typeof input.flags.name === "string") payload.name = input.flags.name;
  if (!isLive(input.flags)) return dryRun("copy", "credential", { credential: id }, `POST credentials/${id}/copy/`, payload);
  const response = yield* write(`credentials/${id}/copy/`, payload, { method: "POST", tag: "security" });
  if (response.status !== 201 && response.status !== 200) throw errorForResponse(response, { subject: `credential ${id}` });
  const body = (response.body ?? {}) as Record<string, unknown>; const copyId = typeof body.id === "number" ? body.id : 0;
  return detailOutput({ label: "credential", fields: { id: copyId, name: body.name ?? null }, help: [`Run \`awx-axi credential show ${copyId}\` to inspect copy`] });
}

function* deleteCredentialPlan(input: SubcommandInput): Plan<DomainResult> {
  const id = yield* resolveId(input.args[0] ?? "", {
    listRoute: "credentials/",
    noun: "credential",
    listCommand: "credential list",
    command: "credential delete",
  });

  const isLive = input.flags.confirm === true && input.flags["dry-run"] !== true;
  if (!isLive) {
    return detailOutput({
      label: "dry_run",
      fields: {
        action: "delete",
        credential: id,
        would_send: `DELETE credentials/${id}/`,
      },
      help: ["Re-run with --confirm to delete"],
    });
  }

  const res = yield* write(`credentials/${id}/`, undefined, { method: "DELETE", tag: "delete" });
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    throw errorForResponse(res, { subject: `credential ${id}` });
  }

  return detailOutput({
    label: "credential",
    fields: {
      id,
      status: "deleted",
    },
  });
}

export const credentialDomain: Domain = defineDomain({
  name: "credential",
  help: [
    "credential: AWX credentials and their metadata",
    "",
    "Subcommands:",
    "  create  [<name>] --credential-type <id|name> [--inputs-file <path>] [--confirm] [--dry-run]",
    "  edit    <id|name> [--name <n>] [--inputs-file <path>] [--confirm] [--dry-run]",
    "  delete  <id|name> [--confirm] [--dry-run]",
    "  copy    <id|name> [--name <name>] [--confirm] [--dry-run]",
    "  list    [--search <s>] [--organization <id>] [--limit <n>]",
    "  show    <id|name>",
  ].join("\n"),
  mcpEquivalents: [
    "list_credentials",
    "create_credential",
    "update_credential",
    "delete_credential",
  ],
  subcommands: [
    {
      name: "copy", help: "awx-axi credential copy <id|name> [--name <name>] [--confirm] [--dry-run]", flags: [{ name: "name", description: "copy name", takesValue: true }, { name: "confirm", description: "confirm live execution", takesValue: false }, { name: "dry-run", description: "preview without mutating", takesValue: false }], positionals: { names: ["<id|name>"], required: 1 }, schema: { label: "credential", defaultFields: [], fieldAllowlist: [] }, suggestions: [], plan: copyCredentialPlan,
    },
    {
      name: "create",
      help: "awx-axi credential create [<name>] --credential-type <id|name> [--inputs-file <path>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "credential name", takesValue: true },
        { name: "credential-type", description: "credential type id or name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "inputs-file", description: "JSON file path (or - for stdin)", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<name>"], required: 0 },
      schema: { label: "credential", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: createCredentialPlan,
    },
    {
      name: "edit",
      help: "awx-axi credential edit <id|name> [--name <n>] [--inputs-file <path>] [--confirm] [--dry-run]",
      flags: [
        { name: "name", description: "credential name", takesValue: true },
        { name: "credential-type", description: "credential type id or name", takesValue: true },
        { name: "organization", description: "organization id or name", takesValue: true },
        { name: "description", description: "description", takesValue: true },
        { name: "inputs-file", description: "JSON file path (or - for stdin)", takesValue: true },
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "credential", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: editCredentialPlan,
    },
    {
      name: "delete",
      help: "awx-axi credential delete <id|name> [--confirm] [--dry-run]",
      flags: [
        { name: "confirm", description: "confirm live execution", takesValue: false },
        { name: "dry-run", description: "dry run without mutating", takesValue: false },
      ],
      positionals: { names: ["<id|name>"], required: 1 },
      schema: { label: "credential", defaultFields: [], fieldAllowlist: [] },
      suggestions: [],
      plan: deleteCredentialPlan,
    },
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
