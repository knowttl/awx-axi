import { Buffer } from "node:buffer";

import { main } from "../../../src/cli.js";
import {
  resolveBasicAuth,
  resolveController,
  type Env,
} from "../../../src/core/auth.js";
import { HttpTransport } from "../../../src/core/transport.js";

interface LiveFetchCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

export interface LiveRun {
  readonly stdout: string;
  readonly exitCode: number;
  readonly calls: readonly LiveFetchCall[];
}

interface LiveRunOptions {
  readonly env?: Env;
}

function valueOrFail(envValue: string | undefined, name: string): string {
  if (envValue === undefined || envValue.trim().length === 0) {
    throw new Error(`${name} must be set to run live checks`);
  }
  return envValue;
}

export function buildLiveEnv(rawEnv: Env = process.env): Env {
  if (rawEnv.AWX_AXI_LIVE !== "1") {
    throw new Error(
      "Live checks are opt-in. Set AWX_AXI_LIVE=1 to run the live suite",
    );
  }

  valueOrFail(rawEnv.CONTROLLER_HOST, "CONTROLLER_HOST");
  valueOrFail(rawEnv.CONTROLLER_USERNAME, "CONTROLLER_USERNAME");
  valueOrFail(rawEnv.CONTROLLER_PASSWORD, "CONTROLLER_PASSWORD");

  const env: Env = { ...rawEnv, AWX_AXI_READ_ONLY: "1" };
  resolveController(env);
  return env;
}

export async function runLiveCli(
  argv: readonly string[],
  options: LiveRunOptions = {},
): Promise<LiveRun> {
  const env = buildLiveEnv(options.env);
  const basic = resolveBasicAuth(env);
  if (basic === undefined) {
    throw new Error(
      "CONTROLLER_USERNAME and CONTROLLER_PASSWORD are required for live checks",
    );
  }

  const config = resolveController(env);
  const calls: LiveFetchCall[] = [];
  const transport = new HttpTransport({
    baseUrl: config.baseUrl,
    apiBasePath: config.apiBasePath,
    authorization: `Basic ${Buffer.from(
      `${basic.username}:${basic.password}`,
    ).toString("base64")}`,
    readOnly: true,
    fetch: (url, init) => {
      calls.push({ method: init.method, url: url.toString(), body: init.body });
      return fetch(url, init);
    },
  });

  const chunks: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    await main({
      argv: [...argv],
      env,
      createTransport: () => transport,
      createBasicAuthTransport: () => transport,
      stdout: {
        write: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    return {
      stdout: chunks.join(""),
      exitCode: Number(process.exitCode ?? 0),
      calls,
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

export function assertNoMutations(calls: readonly LiveFetchCall[]): void {
  for (const call of calls) {
    if (call.method !== "GET") {
      throw new Error(`expected only GET calls, saw ${call.method}`);
    }
  }
}
