import { afterEach, describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";

import { main } from "../src/cli.js";
import { resolveCredential } from "../src/core/auth.js";
import { HttpTransport, type FetchLike } from "../src/core/transport.js";

const TOTAL_LINES = 300;
const LINES = Array.from({ length: TOTAL_LINES }, (_, index) => `line ${index + 1}`);
const ANSI_LINES = LINES.map((line) => `\u001b[0;32m${line}\u001b[0m`);
const BROWSABLE_406 = "<!DOCTYPE html><html><head><title>Job Stdout - AWX REST API</title></head><body>HTTP 406 Not Acceptable</body></html>";

const RENDERER_FOR_FORMAT: Record<string, string> = { json: "application/json", txt: "text/plain" };

/**
 * An AWX stdout endpoint that negotiates content the way Django REST framework
 * does: the `format` query parameter narrows the renderers, and the `Accept`
 * header must still match the one that remains, otherwise the browsable API
 * answers 406 with an HTML page.
 */
function fakeAwx(options: { alwaysNotAcceptable?: boolean } = {}): { fetch: FetchLike; urls: URL[] } {
  const urls: URL[] = [];
  const fetchLike: FetchLike = (rawUrl, init) => {
    const url = new URL(rawUrl);
    urls.push(url);
    if (url.pathname.endsWith("/job_events/")) {
      return Promise.resolve(new Response(JSON.stringify({
        count: 2,
        next: null,
        results: [
          { id: 11, event: "runner_on_ok", host_name: "web-01", task: "debug", failed: false, changed: false, stdout: "console message", event_data: { res: { msg: "result message" } } },
          { id: 12, event: "runner_on_ok", host_name: "web-01", task: "command", failed: false, changed: false, stdout: "console command", event_data: { res: { stdout: "\u001b[0;32mresult command\r\u001b[0m" } } },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    const format = url.searchParams.get("format");
    const accept = init.headers.Accept ?? "*/*";
    const renderer = format === null ? accept : RENDERER_FOR_FORMAT[format];
    const accepted = renderer !== undefined && (accept === "*/*" || accept.includes(renderer));
    if (options.alwaysNotAcceptable === true || !accepted) {
      return Promise.resolve(new Response(BROWSABLE_406, { status: 406, headers: { "Content-Type": "text/html" } }));
    }

    if (format === "txt") {
      return Promise.resolve(new Response(LINES.join("\n"), { status: 200, headers: { "Content-Type": "text/plain" } }));
    }
    const start = Number(url.searchParams.get("start_line") ?? 0);
    const end = Math.min(Number(url.searchParams.get("end_line") ?? TOTAL_LINES), TOTAL_LINES);
    return Promise.resolve(new Response(
      JSON.stringify({ range: { start, end, absolute_end: TOTAL_LINES }, content: `${ANSI_LINES.slice(start, end).join("\n")}\n` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
  };
  return { fetch: fetchLike, urls };
}

async function runAgainst(argv: string[], fetch: FetchLike, token?: string): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  process.exitCode = 0;
  const env = token === undefined ? {} : { XDG_CONFIG_HOME: process.cwd(), AWX_AXI_HOME: process.cwd(), AWX_AXI_ORIGIN: "https://awx.example.com", AWX_AXI_TOKEN: token };
  await main({
    argv,
    env,
    stdout: { write: (chunk) => { stdout += chunk; } },
    createTransport: () => {
      if (token !== undefined) resolveCredential(env);
      return new HttpTransport({ baseUrl: "https://awx.example.com", apiBasePath: "/api/v2/", readOnly: true, fetch, sleep: () => Promise.resolve() });
    },
  });
  return { stdout, exitCode: Number(process.exitCode ?? 0) };
}

const previousExitCode = process.exitCode;
afterEach(() => { process.exitCode = previousExitCode; });

it.each([
  ["job", "job_stdout", ["--type", "job"]],
  ["ad-hoc", "ad_hoc_stdout", []],
  ["job", "stdout", ["--type", "job"]],
])("preserves %s stdout protocol when the token is %s", async (noun, token, extra) => {
  const fetch: FetchLike = async () => new Response(JSON.stringify({ range: { start: 0, end: 1, absolute_end: 1 }, content: `secret ${token}\n` }), { status: 200, headers: { "Content-Type": "application/json" } });
  const result = await runAgainst([noun, "stdout", "7", ...extra], fetch, token);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout).toContain(`${noun === "job" ? "job_stdout" : "ad_hoc_stdout"}:`);
  expect(result.stdout).toContain("\nstdout:\nsecret ***\n");
});

it.each([
  ["job", ["--type", "job"], "stdout", "job *** 7"],
  ["ad-hoc", [], "stdout", "ad-hoc *** 7"],
  ["job", ["--type", "job"], "stdout 7", "job ***"],
])("redacts the %s stdout help when the token is %s", async (noun, extra, token, suggestion) => {
  const result = await runAgainst([noun, "stdout", "7", ...extra], fakeAwx().fetch, token);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.stdout).toContain(`${noun === "job" ? "job_stdout" : "ad_hoc_stdout"}:`);
  expect(result.stdout).toContain("\nstdout:\n");
  expect(result.stdout).toContain(`awx-axi ${suggestion} --lines 1-200`);
  expect(result.stdout.slice(result.stdout.indexOf("\nhelp"))).not.toContain(token);
});

describe.each([
  { noun: "job", id: "1839", extra: ["--type", "job"], header: "job_stdout" },
])("$noun stdout against an AWX that answers 406 HTML to a mismatched format", ({ noun, id, extra, header }) => {
  it("prints the tail by default", async () => {
    const result = await runAgainst([noun, "stdout", id, ...extra], fakeAwx().fetch);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${header}:`);
    expect(result.stdout).toContain("lines: 100-300 of 300");
    expect(result.stdout).toContain("line 300");
    expect(result.stdout).toContain("line 101");
    expect(result.stdout).not.toContain("line 100\n");
    expect(result.stdout).not.toContain("<span");
    expect(result.stdout).not.toContain("\u001b");
  });

  it("honours --tail", async () => {
    const result = await runAgainst([noun, "stdout", id, ...extra, "--tail", "3"], fakeAwx().fetch);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lines: 297-300 of 300");
    expect(result.stdout).toContain("line 298");
    expect(result.stdout).not.toContain("line 297\n");
  });

  it("honours --lines", async () => {
    const result = await runAgainst([noun, "stdout", id, ...extra, "--lines", "0-2"], fakeAwx().fetch);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lines: 0-2 of 300");
    expect(result.stdout).toContain("line 1");
    expect(result.stdout).toContain("line 2");
    expect(result.stdout).not.toContain("line 3\n");
  });

  it("prints everything with --full", async () => {
    const result = await runAgainst([noun, "stdout", id, ...extra, "--full"], fakeAwx().fetch);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lines: 0-300 of 300");
    expect(result.stdout).toContain("line 1\n");
    expect(result.stdout).toContain("line 300");
  });

  it("keeps colour codes only with --ansi", async () => {
    const result = await runAgainst([noun, "stdout", id, ...extra, "--tail", "1", "--ansi"], fakeAwx().fetch);

    expect(result.stdout).toContain("\u001b[0;32mline 300\u001b[0m");
  });

  it("reports an HTML error page as an error and never prints it", async () => {
    const result = await runAgainst([noun, "stdout", id, ...extra], fakeAwx({ alwaysNotAcceptable: true }).fetch);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("code: ");
    expect(result.stdout).toContain("406");
    expect(result.stdout).not.toContain("<html");
    expect(result.stdout).not.toContain("Job Stdout - AWX REST API");
  });
});

describe("job events --full", () => {
  it("adds distinct console and result text for message and command events", async () => {
    const result = await runAgainst(["job", "events", "1839", "--type", "job", "--full"], fakeAwx().fetch);

    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toMatchObject({ events: [
      { id: 11, stdout: "console message", result: "result message" },
      { id: 12, stdout: "console command", result: "result command" },
    ] });
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\r");
  });

  it("leaves the console text out without --full", async () => {
    const result = await runAgainst(["job", "events", "1839", "--type", "job"], fakeAwx().fetch);

    expect(result.stdout).not.toContain("console message");
    expect(result.stdout).not.toContain("result command");
  });
});

describe("ad-hoc stdout against an AWX that answers 406 HTML to a mismatched format", () => {
  it("prints the whole output by default", async () => {
    const result = await runAgainst(["ad-hoc", "stdout", "401"], fakeAwx().fetch);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ad_hoc_stdout:");
    expect(result.stdout).toContain("lines: 0-300 of 300");
    expect(result.stdout).toContain("line 300");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("<span");
  });

  it("honours --tail", async () => {
    const result = await runAgainst(["ad-hoc", "stdout", "401", "--tail", "3"], fakeAwx().fetch);

    expect(result.stdout).toContain("lines: 297-300 of 300");
    expect(result.stdout).not.toContain("line 297\n");
  });

  it("reports an HTML error page as an error and never prints it", async () => {
    const result = await runAgainst(["ad-hoc", "stdout", "401"], fakeAwx({ alwaysNotAcceptable: true }).fetch);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("406");
    expect(result.stdout).not.toContain("<html");
  });
});
