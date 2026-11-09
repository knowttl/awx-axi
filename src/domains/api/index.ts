/**
 * The `api` domain: the raw AWX REST API for endpoints no dedicated noun covers.
 *
 * Reads are free. Writes preview by default, need `--confirm`, and always carry
 * the security tag: a raw path can reach any resource, so the strictest write
 * gate applies, plus the delete gate for DELETE.
 */
import { errorForResponse, validationError } from "../../core/errors.js";
import { detailOutput } from "../../core/output.js";
import { dryRun, isLive, MUTATION_FLAGS, parseJsonObject } from "../../core/mutations.js";
import { PrivateFiles } from "../../core/private-file.js";
import { isSensitiveKey, REDACTION, registerSecretValues } from "../../core/redact.js";
import { booleanEnv } from "../../core/profiles.js";
import { AxiError } from "axi-sdk-js";
import { parse as parseYaml } from "yaml";
import {
  defineDomain,
  read,
  write,
  type Domain,
  type DomainResult,
  type HttpMutationMethod,
  type Plan,
  type SubcommandInput,
  type SubcommandSpec,
} from "../../core/registry.js";
import { assertWritable, type AwxResponse, type Query } from "../../core/transport.js";

const SAFE_PATH = /^[A-Za-z0-9_.~%@+/-]+$/;

const RESPONSE_SCHEMA = {
  label: "api_response",
  defaultFields: ["method", "path", "status", "body"],
  fieldAllowlist: [],
} as const;

function parsePath(raw: string, command: string): string {
  if (command === "get" && raw === ".") return raw;
  if (raw.startsWith("/")) {
    throw validationError(`\`api ${command}\` paths are relative to the API root, got "${raw}"`, [
      "Drop the leading slash and the /api/v2/ prefix, e.g. `awx-axi api get jobs/1839/`",
    ]);
  }
  if (!SAFE_PATH.test(raw) || /%2e/i.test(raw) || raw.split("/").some((segment) => segment === "." || segment === "..")) {
    throw validationError(`\`api ${command}\` path "${raw}" must be plain path segments`, [
      "Pass query parameters with --query and never use dot segments or encoded dots",
    ]);
  }
  try { decodeURIComponent(raw); } catch { throw validationError("path contains invalid encoding"); }
  return raw;
}

function parseQuery(raw: string | true | undefined): Query {
  if (typeof raw !== "string") return {};
  const result: Query = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const previous = result[key];
    result[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [String(previous), value];
  }
  return result;
}

function readBody(flags: SubcommandInput["flags"]): Record<string, unknown> | undefined {
  const file = flags["body-file"];
  if (typeof file === "string") {
    const text = new PrivateFiles().read(file, true);
    if (text === undefined) throw validationError(`--body-file ${file} does not exist`);
    return parseJsonObject(text, "--body-file");
  }
  return undefined;
}

function protectBody(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => protectBody(entry, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "extra_vars" && typeof entry === "string") {
      const before = secrets.length;
      try {
        protectBody(parseYaml(entry), secrets);
      } catch {
        return [key, entry];
      }
      return [key, secrets.length > before ? REDACTION : entry];
    }
    if (isSensitiveKey(key) || /^(?:inputs|notification_configuration)$/i.test(key)) {
      const collect = (item: unknown): void => {
        if (typeof item === "string" && item.length > 0) secrets.push(item);
        else if (typeof item === "number" || typeof item === "boolean") secrets.push(String(item));
        else if (item !== null && typeof item === "object") Object.values(item).forEach(collect);
      };
      collect(entry);
      registerSecretValues(entry);
      return [key, REDACTION];
    }
    return [key, protectBody(entry, secrets)];
  }));
}

function scrubResponse(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return secrets.includes(value) ? REDACTION : value;
  if ((typeof value === "number" || typeof value === "boolean") && secrets.includes(String(value))) return REDACTION;
  if (Array.isArray(value)) return value.map((entry) => scrubResponse(entry, secrets));
  if (value === null || typeof value !== "object") return value;
  const credential = "credential_type" in value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, isSensitiveKey(key) || (credential && key === "inputs") ? REDACTION : scrubResponse(entry, secrets),
  ]));
}

function responseOutput(method: string, path: string, response: AwxResponse, secrets: readonly string[] = []) {
  const body = scrubResponse(response.body ?? null, secrets);
  if (response.status < 200 || response.status >= 300) {
    throw errorForResponse({ ...response, body }, { subject: `${method} ${path}` });
  }
  return detailOutput({
    label: RESPONSE_SCHEMA.label,
    fields: { method, path, status: response.status, body },
  });
}

function* getPlan(input: SubcommandInput): Plan<DomainResult> {
  const path = parsePath(input.args[0] as string, "get");
  const response = yield* read(path, parseQuery(input.flags.query), undefined, true);
  return responseOutput("GET", path, response);
}

function writePlan(method: HttpMutationMethod) {
  return function* (input: SubcommandInput): Plan<DomainResult> {
    const path = parsePath(input.args[0] as string, method.toLowerCase());
    const body = readBody(input.flags);
    if (decodeURIComponent(path).toLowerCase().replace(/\/+$/, "") === "bulk/job_launch") {
      throw validationError("`api` refuses bulk/job_launch/: bulk job launch is excluded from awx-axi (design.md section 2)", [
        "Launch jobs one at a time with `awx-axi template launch` or `awx-axi workflow launch`",
      ]);
    }
    const secrets: string[] = [];
    const preview = protectBody(body, secrets) as Record<string, unknown> | undefined;
    if (!isLive(input.flags)) {
      return dryRun("send", "api_request", { method, path }, `${method} ${path}`, scrubResponse(preview, secrets) as Record<string, unknown> | undefined);
    }
    const normalized = decodeURIComponent(path).toLowerCase().replace(/\/+$/, "");
    if (method === "DELETE" || normalized === "bulk/host_delete") assertWritable(input.context.env, method, path, "delete");
    else if (!/^(?:credentials|users|teams|roles|tokens)(?:\/[^/]+)?$/.test(normalized) &&
      !(method === "POST" && /^[^/]+\/[^/]+\/(?:credentials|galaxy_credentials|users|teams|roles|object_roles|tokens|personal_tokens|admins)$/.test(normalized)) &&
      !(method === "POST" && /^(?:(?:job_templates|workflow_job_templates|system_job_templates)\/[^/]+\/launch|(?:jobs|workflow_jobs|system_jobs|project_updates|inventory_updates|ad_hoc_commands)\/[^/]+\/(?:cancel|relaunch)|(?:projects|inventory_sources)\/[^/]+\/update|notification_templates\/[^/]+\/test|workflow_approvals\/[^/]+\/(?:approve|deny)|ad_hoc_commands)$/.test(normalized))) {
      assertWritable(input.context.env, method, path, "config");
    }
    if (body?.credential_passwords !== undefined && /(?:^|\/)launch$/.test(normalized)) {
      if (typeof input.flags["body-file"] !== "string" || !booleanEnv(input.context.env, "AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS")) {
        throw new AxiError("credential passwords require a private body file and AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS=1", "LAUNCH_INPUT_REQUIRED");
      }
    }
    const response = yield* write(path, body, { method, tag: "security" });
    return responseOutput(method, path, response, secrets);
  };
}

function writeSubcommand(method: HttpMutationMethod, hasBody: boolean): SubcommandSpec {
  const name = method.toLowerCase();
  const bodyFlags = hasBody
    ? [
        { name: "body-file", description: "path to a 0600 JSON file holding the request body", takesValue: true },
      ]
    : [];
  return {
    name,
    help: [
      `awx-axi api ${name} <path>${hasBody ? " [--body-file <path>]" : ""} [--confirm] [--dry-run]`,
      "",
      `Sends ${method} to the AWX API. Previews by default; --confirm sends it.`,
      "Requires AWX_AXI_ALLOW_SECURITY_WRITES=1 and applicable configuration or delete gates.",
      "Launch credential passwords require a private body file and AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS=1.",
      "The method, timestamp and status go to the write journal; the payload does not.",
      ...(hasBody ? ["Request bodies must be in a private --body-file (0600)."] : []),
      "",
      "Examples:",
      method === "DELETE" ? "  awx-axi api delete labels/7/ --confirm" : `  awx-axi api ${name} jobs/1839/cancel/ --confirm`,
    ].join("\n"),
    flags: [...bodyFlags, ...MUTATION_FLAGS],
    positionals: { names: ["<path>"], required: 1 },
    schema: RESPONSE_SCHEMA,
    suggestions: [],
    plan: writePlan(method),
  };
}

export const apiDomain: Domain = defineDomain({
  name: "api",
  help: [
    "api: the raw AWX REST API, for endpoints no dedicated noun covers",
    "",
    "Subcommands:",
    "  get     <path> [--query <k=v&k=v>]   read any endpoint",
    "  post    <path> [--body-file <path>]   preview or send a POST",
    "  put     <path> [--body-file <path>]   preview or send a PUT",
    "  patch   <path> [--body-file <path>]   preview or send a PATCH",
    "  delete  <path>                       preview or send a DELETE",
    "",
    "Paths are relative to the API root (jobs/1839/, not /api/v2/jobs/1839/).",
    "Writes preview unless --confirm is passed.",
    "bulk/job_launch/ is refused: bulk job launch is excluded from awx-axi.",
  ].join("\n"),
  subcommands: [
    {
      name: "get",
      help: [
        "awx-axi api get <path> [--query <k=v&k=v>]",
        "",
        "Reads one endpoint and prints the redacted response as TOON.",
        "Use . to read the API root.",
        "",
        "Examples:",
        "  awx-axi api get jobs/1839/",
        '  awx-axi api get jobs/ --query "status=failed&page_size=5"',
      ].join("\n"),
      flags: [{ name: "query", description: "query string, k=v pairs joined by &", takesValue: true }],
      positionals: { names: ["<path>"], required: 1 },
      schema: RESPONSE_SCHEMA,
      suggestions: [],
      plan: getPlan,
    },
    writeSubcommand("POST", true),
    writeSubcommand("PUT", true),
    writeSubcommand("PATCH", true),
    writeSubcommand("DELETE", false),
  ],
});
