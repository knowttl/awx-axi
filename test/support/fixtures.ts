import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FetchLike, RecordedExchange } from "../../src/core/transport.js";

/**
 * A recorded AWX 24.6.1 response.
 *
 * Every fixture records the source file and line it was derived from (§11.2),
 * so it can be re-verified against the tag rather than trusted. `test/fixtures.test.ts`
 * enforces that.
 */
export interface Fixture {
  readonly $tag: string;
  readonly $source: string;
  readonly $note: string;
  readonly status: number;
  readonly body: unknown;
}

const DIRECTORY = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function fixtureNames(): string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

export function loadFixture(name: string): Fixture {
  const path = `${DIRECTORY}${name}.json`;
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

/** One fixture, as a scripted exchange for `RecordedTransport`. */
export function exchange(name: string): RecordedExchange {
  const fixture = loadFixture(name);
  return { status: fixture.status, body: fixture.body };
}

export interface FetchCall {
  readonly method: string;
  readonly url: URL;
  readonly body: string | undefined;
}

/**
 * A fixture-serving `fetch`, so `HttpTransport`'s own wire behavior - which
 * query parameters it sends, which links it follows - can be asserted offline.
 * `RecordedTransport` sits above that seam and cannot see it.
 */
export function fixtureFetch(names: readonly string[]): {
  fetch: FetchLike;
  calls: FetchCall[];
} {
  const queue = [...names];
  const calls: FetchCall[] = [];

  const fetchLike: FetchLike = (url, init) => {
    calls.push({
      method: init.method,
      url: new URL(url),
      body: init.body,
    });

    const name = queue.shift();
    if (name === undefined) {
      throw new Error(`no fixture left to serve for ${init.method} ${url}`);
    }
    const fixture = loadFixture(name);

    return Promise.resolve(
      new Response(
        fixture.status === 204 ? null : JSON.stringify(fixture.body),
        {
          status: fixture.status,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  return { fetch: fetchLike, calls };
}
