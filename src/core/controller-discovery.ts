import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { AxiError } from "axi-sdk-js";

import type { ControllerConfig } from "./auth.js";
import { errorForResponse } from "./errors.js";
import { PrivateFiles } from "./private-file.js";
import { toolDirectory, type Env } from "./profiles.js";
import { read, runPlan, type Plan } from "./registry.js";
import type { AwxTransport } from "./transport.js";

interface ControllerMetadata {
  apiBasePath: string;
  release: string;
}

export async function discoverController(
  controller: ControllerConfig,
  env: Env,
  createTransport: () => AwxTransport,
): Promise<ControllerMetadata> {
  const key = createHash("sha256").update(JSON.stringify([
    controller.baseUrl, env.AWX_AXI_API_BASE_PATH ?? null,
  ])).digest("hex");
  const path = join(toolDirectory("state", env, process.platform, env.HOME || homedir()), "controllers", `${key}.json`);
  const files = new PrivateFiles();
  const cached = files.read(path);
  if (cached !== undefined) {
    let metadata: unknown;
    try { metadata = JSON.parse(cached); } catch { throw invalidResponse(); }
    if (!validMetadata(metadata, controller.baseUrl)) throw invalidResponse();
    return metadata;
  }
  const metadata = await runPlan(discoveryPlan(controller, env), { transport: createTransport() });
  files.write(path, `${JSON.stringify(metadata)}\n`);
  return metadata;
}

function* discoveryPlan(controller: ControllerConfig, env: Env): Plan<ControllerMetadata> {
  let apiBasePath = controller.apiBasePath;
  if (env.AWX_AXI_API_BASE_PATH === undefined) {
    const root = yield* read("api/");
    if (root.status !== 200) throw errorForResponse(root, { subject: "controller discovery" });
    const body = root.body as { available_versions?: { v2?: unknown } } | null;
    const advertised = body?.available_versions?.v2;
    if (typeof advertised !== "string" || !validPath(advertised, controller.baseUrl)) throw invalidResponse();
    apiBasePath = advertised;
  }
  const ping = yield* read(`${apiBasePath.slice(1)}ping/`);
  if (ping.status !== 200) throw errorForResponse(ping, { subject: "controller discovery" });
  const metadata = { apiBasePath, release: (ping.body as { version?: unknown } | null)?.version };
  if (!validMetadata(metadata, controller.baseUrl)) throw invalidResponse();
  return metadata;
}

function validPath(path: string, origin: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && path.endsWith("/")
    && new URL(path, origin).origin === origin && new URL(path, origin).pathname === path;
}

function validMetadata(value: unknown, origin: string): value is ControllerMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<ControllerMetadata>;
  return typeof metadata.apiBasePath === "string" && validPath(metadata.apiBasePath, origin)
    && typeof metadata.release === "string" && /^[0-9][A-Za-z0-9.+_-]{0,127}$/.test(metadata.release);
}

function invalidResponse(): AxiError {
  return new AxiError("invalid controller discovery response", "INVALID_RESPONSE");
}
