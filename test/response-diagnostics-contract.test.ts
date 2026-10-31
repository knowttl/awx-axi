import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ResponseDiagnostics } from "../src/response-diagnostics.js";

// Canonical byte contract from knowttl/beyondtrust-axi main at
// f2327c69a9b18a580957b653c5e1fd190e0077ff. Vectors are not AWX recordings.
const vectors = JSON.parse(readFileSync(new URL("./contracts/response-diagnostics-vectors.json", import.meta.url), "utf8")) as {
  name: string; status: number; contentType?: string; data: unknown; secrets?: string[];
  issues?: { path: (string | number)[]; expected?: unknown; code?: unknown }[];
  expected: Record<string, unknown>;
}[];
const hashes = JSON.parse(readFileSync(new URL("./contracts/response-diagnostics-sha256.json", import.meta.url), "utf8")) as Record<string, string>;

test.each(vectors)("shared diagnostics vector: $name", (vector) => {
  const diagnostics = new ResponseDiagnostics({
    text: (text) => (vector.secrets ?? []).reduce((text, secret) => text.replaceAll(secret, "***redacted***"), text),
  }, ["INVALID_RESPONSE"]);
  diagnostics.record(vector.status, new Headers(vector.contentType ? { "content-type": vector.contentType } : {}), vector.data);
  if (vector.issues) diagnostics.validationFailed(vector.issues);
  expect(diagnostics.forError({ code: "INVALID_RESPONSE" })).toEqual(vector.expected);
  expect(diagnostics.forError({ code: "AUTH_REQUIRED" })).toEqual({});
});

test.each(Object.entries(hashes))("canonical copy SHA-256: %s", (path, hash) => {
  const localPath = path.replace("test/fixtures/", "test/contracts/");
  const bytes = readFileSync(new URL(`../${localPath}`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
});
