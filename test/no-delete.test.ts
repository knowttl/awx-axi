import { describe, expect, it } from "vitest";

import type { RouteDescription } from "../src/core/registry.js";
import type { AwxTransport } from "../src/core/transport.js";

/**
 * The compile-time no-delete property (design.md §2, §10.2, §10.3).
 *
 * These assertions are checked by `npm run typecheck`, which CI runs: a failure
 * is a type error at build time, not a failed expectation at run time. The
 * runtime cases below exist so the property is named in the test report too.
 */
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type HasAny<T, K extends PropertyKey> = [Extract<keyof T, K>] extends [never]
  ? false
  : true;

// `post` is the only mutating method on the seam: there is no `del`, `put`, or
// `patch` for any command or future contributor to call.
type _NoMutatorsBeyondPost = Expect<
  Equal<HasAny<AwxTransport, "delete" | "del" | "put" | "patch">, false>
>;
type _TransportSurfaceIsClosed = Expect<
  Equal<keyof AwxTransport, "get" | "post" | "getPaged" | "getText">
>;

// A route description carries no HTTP verb, so a domain cannot describe a
// DELETE even by mistake.
type _RouteCarriesNoVerb = Expect<
  Equal<HasAny<RouteDescription, "method" | "verb" | "httpMethod">, false>
>;
type _RouteSurfaceIsClosed = Expect<Equal<keyof RouteDescription, "path" | "query">>;

describe("the no-delete property", () => {
  it("exposes no delete, put, or patch on the transport", () => {
    const surface: Array<keyof AwxTransport> = [
      "get",
      "post",
      "getPaged",
      "getText",
    ];

    expect(surface).toHaveLength(4);
  });

  it("carries no HTTP verb on a route description", () => {
    const surface: Array<keyof RouteDescription> = ["path", "query"];

    expect(surface).toHaveLength(2);
  });
});
