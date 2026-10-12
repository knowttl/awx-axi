import { main } from "../../../src/cli.js";
import {
  requireCredential,
  resolveController,
  type Env,
} from "../../../src/core/auth.js";
import { normalizeEnv } from "../../../src/core/profiles.js";
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

  const env: Env = { ...normalizeEnv(rawEnv), AWX_AXI_READ_ONLY: "1" };
  valueOrFail(env.AWX_AXI_ORIGIN, "AWX_AXI_ORIGIN");
  valueOrFail(env.AWX_AXI_TOKEN, "AWX_AXI_TOKEN");
  resolveController(env);
  return env;
}

export async function runLiveCli(
  argv: readonly string[],
  options: LiveRunOptions = {},
): Promise<LiveRun> {
  const env = buildLiveEnv(options.env);
  const credential = requireCredential(env);
  const config = resolveController(env);
  const calls: LiveFetchCall[] = [];
  const transport = new HttpTransport({
    baseUrl: config.baseUrl,
    apiBasePath: config.apiBasePath,
    authorization: `Bearer ${credential.token}`,
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
