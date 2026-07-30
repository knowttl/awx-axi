import { DOMAINS, main, type MainOptions } from "../../src/cli.js";
import type { Domain } from "../../src/core/registry.js";
import {
  RecordedTransport,
  type RecordedExchange,
} from "../../src/core/transport.js";
import { fakeDomain } from "./fake-domain.js";
import { exchange } from "./fixtures.js";

export interface CliRun {
  readonly stdout: string;
  readonly exitCode: number;
  readonly transport: RecordedTransport;
}

export interface CliRunOptions {
  /** Fixture names and inline exchanges, replayed in the order given. */
  readonly script?: readonly (string | RecordedExchange)[];
  readonly env?: Record<string, string | undefined>;
  readonly domain?: Domain;
  /** Records the §7.9 backoff waits. Resolves immediately by default. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Run the whole CLI end to end - dispatch, flag validation, plan execution,
 * rendering, and exit code - against `RecordedTransport`. Offline, with no
 * network and no mocking framework.
 */
export async function runCli(
  argv: string[],
  options: CliRunOptions = {},
): Promise<CliRun> {
  const transport = new RecordedTransport(
    (options.script ?? []).map((step) =>
      typeof step === "string" ? exchange(step) : step,
    ),
    {
      readOnly: options.env?.AWX_AXI_READ_ONLY === "1",
      ...(options.env !== undefined ? { env: options.env } : {}),
    },
  );

  const chunks: string[] = [];
  const domains = DOMAINS as Domain[];
  domains.push(options.domain ?? fakeDomain);
  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  const mainOptions: MainOptions = {
    argv,
    stdout: {
      write: (chunk) => {
        chunks.push(chunk);
      },
    },
    env: options.env ?? {},
    createTransport: () => transport,
    createBasicAuthTransport: () => transport,
    sleep: options.sleep ?? (() => Promise.resolve()),
  };

  try {
    await main(mainOptions);
    return {
      stdout: chunks.join(""),
      exitCode: Number(process.exitCode ?? 0),
      transport,
    };
  } finally {
    domains.pop();
    process.exitCode = previousExitCode;
  }
}
