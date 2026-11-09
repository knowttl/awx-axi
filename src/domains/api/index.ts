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
  return raw;
}

function parseQuery(raw: string | true | undefined): Query {
  if (typeof raw !== "string") return {};
  return Object.fromEntries(new URLSearchParams(raw));
}

function readBody(flags: SubcommandInput["flags"]): Record<string, unknown> | undefined {
  const inline = flags.body;
  const file = flags["body-file"];
  if (inline !== undefined && file !== undefined) {
    throw validationError("--body and --body-file are mutually exclusive");
  }
  if (typeof inline === "string") return parseJsonObject(inline, "--body");
  if (typeof file === "string") {
    const text = new PrivateFiles().read(file, true);
    if (text === undefined) throw validationError(`--body-file ${file} does not exist`);
    return parseJsonObject(text, "--body-file");
  }
  return undefined;
}

function responseOutput(method: string, path: string, response: AwxResponse) {
  if (response.status < 200 || response.status >= 300) {
    throw errorForResponse(response, { subject: `${method} ${path}` });
  }
  return detailOutput({
    label: RESPONSE_SCHEMA.label,
    fields: { method, path, status: response.status, body: response.body ?? null },
  });
}

function* getPlan(input: SubcommandInput): Plan<DomainResult> {
  const path = parsePath(input.args[0] as string, "get");
  const response = yield* read(path, parseQuery(input.flags.query));
  return responseOutput("GET", path, response);
}

function writePlan(method: HttpMutationMethod) {
  return function* (input: SubcommandInput): Plan<DomainResult> {
    const path = parsePath(input.args[0] as string, method.toLowerCase());
    const body = readBody(input.flags);
    if (!isLive(input.flags)) {
      return dryRun("send", "api_request", { method, path }, `${method} ${path}`, body);
    }
    if (method === "DELETE") assertWritable(input.context.env, method, path, "delete");
    const response = yield* write(path, body, { method, tag: "security" });
    return responseOutput(method, path, response);
  };
}

function writeSubcommand(method: HttpMutationMethod, hasBody: boolean): SubcommandSpec {
  const name = method.toLowerCase();
  const bodyFlags = hasBody
    ? [
        { name: "body", description: "JSON object request body", takesValue: true },
        { name: "body-file", description: "path to a 0600 JSON file holding the request body", takesValue: true },
      ]
    : [];
  return {
    name,
    help: [
      `awx-axi api ${name} <path>${hasBody ? " [--body <json> | --body-file <path>]" : ""} [--confirm] [--dry-run]`,
      "",
      `Sends ${method} to the AWX API. Previews by default; --confirm sends it.`,
      "Requires AWX_AXI_ALLOW_SECURITY_WRITES=1" + (method === "DELETE" ? " and AWX_AXI_ALLOW_DELETES=1." : "."),
      "The method, timestamp and status go to the write journal; the payload does not.",
      ...(hasBody ? ["Put secrets in --body-file (0600), never in --body."] : []),
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
    "  post    <path> [--body <json> | --body-file <path>]   preview or send a POST",
    "  put     <path> [--body <json> | --body-file <path>]   preview or send a PUT",
    "  patch   <path> [--body <json> | --body-file <path>]   preview or send a PATCH",
    "  delete  <path>                       preview or send a DELETE",
    "",
    "Paths are relative to the API root (jobs/1839/, not /api/v2/jobs/1839/).",
    "Writes preview unless --confirm is passed.",
  ].join("\n"),
  subcommands: [
    {
      name: "get",
      help: [
        "awx-axi api get <path> [--query <k=v&k=v>]",
        "",
        "Reads one endpoint and prints the redacted JSON response as TOON.",
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
