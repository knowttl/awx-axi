import { describe, expect, it } from "vitest";

import {
  AwxAxiError,
  describeAwxBody,
  errorForResponse,
  formatError,
} from "../src/core/errors.js";
import {
  assertNoSecretFlags,
  assertUsableArity,
  parseFlags,
} from "../src/core/flags.js";
import { countLine, listOutput, rawRegion, truncate } from "../src/core/output.js";
import { redact, redactValue } from "../src/core/redact.js";
import {
  defineDomain,
  read,
  readPaged,
  readText,
  write,
} from "../src/core/registry.js";
import { loadFixture } from "./support/fixtures.js";

describe("error translation (design.md §9.3)", () => {
  it("translates AWX's field-error dict", () => {
    const fixture = loadFixture("error-field-dict");

    const error = errorForResponse(fixture, {
      subject: "template 12",
      codes: { 400: "LAUNCH_REJECTED" },
    });

    expect(error.code).toBe("LAUNCH_REJECTED");
    expect(error.message).toBe(
      'template 12: extra_vars: survey question "approver" is required',
    );
  });

  it("translates AWX's __all__ non-field key without printing the key", () => {
    const fixture = loadFixture("error-all");

    const error = errorForResponse(fixture, { subject: "template 12" });

    expect(error.message).toBe(
      "template 12: Job Template does not have a default inventory",
    );
    expect(error.message).not.toContain("__all__");
  });

  it("translates a permission body to FORBIDDEN with an awx-axi next step", () => {
    const fixture = loadFixture("error-detail");

    const error = errorForResponse(fixture, { subject: "template 12" });

    expect(error.code).toBe("FORBIDDEN");
    expect(error.suggestions[0]).toContain("awx-axi auth status");
    // Suggestions reference awx-axi commands only, never the underlying API.
    for (const suggestion of error.suggestions) {
      expect(suggestion).not.toMatch(/\/api\/v2\//);
    }
  });

  it("states its own summary rather than leaking an unrecognized payload", () => {
    const error = errorForResponse(
      { status: 500, body: { traceback: ["File \"views.py\", line 1"] } },
      { subject: "job 1839" },
    );

    expect(error.code).toBe("SERVER_ERROR");
    expect(error.message).not.toContain("views.py");
  });

  it("recognizes only the three documented body shapes", () => {
    expect(describeAwxBody([1, 2, 3])).toBeUndefined();
    expect(describeAwxBody(null)).toBeUndefined();
    // The field-error form is a 400 shape and nothing else.
    expect(describeAwxBody({ field: ["bad"] }, 500)).toBeUndefined();
  });
});

describe("exit codes (design.md §9)", () => {
  it.each([
    ["VALIDATION_ERROR", 2],
    ["AMBIGUOUS_NAME", 2],
    ["LAUNCH_WOULD_IGNORE_INPUT", 2],
    ["LAUNCH_INPUT_REQUIRED", 2],
    ["NAME_NOT_FOUND", 1],
    ["READ_ONLY_VIOLATION", 1],
    ["WATCH_TIMEOUT", 1],
  ])("maps %s to exit %i", (code, exitCode) => {
    expect(formatError(new AwxAxiError("boom", code)).exitCode).toBe(exitCode);
  });

  it("renders the extra blocks between code and help", () => {
    const { output } = formatError(
      new AwxAxiError("2 job templates are named \"x\"", "AMBIGUOUS_NAME", ["Re-run with the id"], {
        candidates: [{ id: 12, name: "x", organization: "Production" }],
      }),
    );

    expect(output).toContain("code: AMBIGUOUS_NAME");
    expect(output).toContain("candidates[1]{id,name,organization}:");
    expect(output.indexOf("candidates")).toBeLessThan(output.indexOf("help["));
  });
});

describe("the secret-name guard (design.md §5.3)", () => {
  it.each(["token", "password", "api-key", "vault-passphrase", "client-secret"])(
    "refuses a flag named --%s at registration",
    (name) => {
      expect(() =>
        assertNoSecretFlags("template launch", [
          { name, description: "", takesValue: true },
        ]),
      ).toThrow(/a secret is never a command-line argument/);
    },
  );

  it("allows a path to a secret, which is not a secret", () => {
    expect(() =>
      assertNoSecretFlags("template launch", [
        { name: "credential-passwords-file", description: "", takesValue: true },
      ]),
    ).not.toThrow();
  });

  it("fires when a domain is defined, not when it is run", () => {
    expect(() =>
      defineDomain({
        name: "gadget",
        help: "",
        mcpEquivalents: [],
        subcommands: [
          {
            name: "launch",
            help: "",
            flags: [{ name: "token", description: "", takesValue: true }],
            positionals: { names: ["<id>"], required: 1 },
            schema: { label: "g", defaultFields: [], fieldAllowlist: [] },
            suggestions: [],
            // eslint-disable-next-line require-yield
            plan: function* () {
              return {};
            },
          },
        ],
      }),
    ).toThrow(/design.md §5.3/);
  });
});

const NO_ARGS = { names: [], required: 0 } as const;
const ONE_ARG = { names: ["<id>"], required: 1 } as const;
const OPTIONAL_ARG = { names: ["<id>"], required: 0 } as const;

describe("unknown flags fail loud (design.md §9.4)", () => {
  const FLAGS = [
    { name: "status", description: "", takesValue: true },
    { name: "failed", description: "", takesValue: false },
    { name: "limit", description: "", takesValue: true },
  ];

  it("rejects by name and inlines the valid flags", () => {
    expect(() => parseFlags("job list", ["--state", "failed"], FLAGS, OPTIONAL_ARG)).toThrow(
      /unknown flag --state for `job list`/,
    );
  });

  it("points a renamed flag at its replacement", () => {
    try {
      parseFlags("job list", ["--state", "failed"], FLAGS, OPTIONAL_ARG);
      expect.unreachable();
    } catch (error) {
      expect((error as { suggestions: string[] }).suggestions).toEqual([
        "Did you mean --status?",
        "valid flags for `job list`: --status, --failed, --limit",
      ]);
    }
  });

  it("always allows --help", () => {
    expect(parseFlags("job list", ["--help"], FLAGS, NO_ARGS).flags).toEqual({});
  });

  it("rejects a surplus positional by name, so nothing acts on the first alone", () => {
    try {
      parseFlags("job cancel", ["1839", "1841"], FLAGS, ONE_ARG);
      expect.unreachable();
    } catch (error) {
      const failure = error as { code: string; message: string; suggestions: string[] };
      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.message).toContain("1841 is unexpected");
      expect(failure.suggestions[0]).toContain("awx-axi job cancel 1839");
    }
  });

  it("names every surplus positional, not just the first", () => {
    expect(() => parseFlags("job cancel", ["1", "2", "3"], FLAGS, ONE_ARG)).toThrow(
      /2, 3 are unexpected/,
    );
  });

  it("rejects a missing required positional, naming it", () => {
    try {
      parseFlags("job cancel", [], FLAGS, ONE_ARG);
      expect.unreachable();
    } catch (error) {
      const failure = error as {
        code: string;
        message: string;
        suggestions: string[];
      };
      expect(failure.code).toBe("VALIDATION_ERROR");
      expect(failure.message).toBe("`job cancel` needs <id>");
      expect(failure.suggestions[0]).toBe("Run `awx-axi job cancel <id>`");
    }
  });

  it("names every missing required positional", () => {
    expect(() =>
      parseFlags("job move", [], FLAGS, {
        names: ["<id>", "<destination>"],
        required: 2,
      }),
    ).toThrow(/needs <id> and <destination>/);
  });

  it("accepts an omitted optional positional", () => {
    expect(parseFlags("job list", [], FLAGS, OPTIONAL_ARG).args).toEqual([]);
  });

  it("refuses any positional for a subcommand that takes none", () => {
    expect(() => parseFlags("auth status", ["extra"], [], NO_ARGS)).toThrow(
      /takes 0 arguments but got 1/,
    );
  });

  it("parses values, booleans, positionals, and = form", () => {
    const parsed = parseFlags(
      "job list",
      ["1839", "--status=failed", "--failed", "--limit", "20"],
      FLAGS,
      ONE_ARG,
    );

    expect(parsed.args).toEqual(["1839"]);
    expect(parsed.flags).toEqual({
      status: "failed",
      failed: true,
      limit: "20",
    });
  });
});

describe("the base-relative route guard (design.md §4.2)", () => {
  it.each([
    ["read", () => read("/api/v2/jobs/1839/")],
    ["readPaged", () => readPaged("/api/v2/jobs/", {}, 20)],
    ["readText", () => readText("/api/v2/jobs/1839/stdout/")],
    ["write", () => write("/api/v2/jobs/1839/cancel/")],
  ])("refuses a leading slash declared through %s", (_name, declare) => {
    // A leading slash resolves identically under the default /api/v2/, so only
    // an AWX_AXI_API_BASE_PATH override would expose it - silently. Hence the
    // guard rather than prose.
    expect(() => declare().next()).toThrow(/must be base-relative/);
  });

  it("accepts the base-relative form every domain is meant to write", () => {
    expect(() => read("jobs/1839/").next()).not.toThrow();
  });

  it("refuses an arity range no caller could satisfy, at definition time", () => {
    expect(() =>
      assertUsableArity("gadget cancel", { names: ["<id>"], required: 2 }),
    ).toThrow(/unsatisfiable/);
  });
});

describe("redaction (design.md §6.4)", () => {
  it("removes credentials embedded in an SCM URL", () => {
    const body = loadFixture("stdout-ranged").body as {
      content: string;
    };

    const redacted = redact(body.content);

    expect(redacted).not.toContain("s3cr3t-token");
    expect(redacted).not.toContain("btsai:");
    expect(redacted).toContain("https://***@github.com/knowttl/infra-playbooks");
  });

  it("collapses AWX's own $encrypted$ marker to the bare marker", () => {
    expect(redact('"vault_password": "$encrypted$UTF8$AES256$abc123"')).toBe(
      '"vault_password": "$encrypted$"',
    );
  });

  it("recursively redacts nested payload values", () => {
    expect(redactValue({
      token: "abc",
      message: "https://user:abc@hooks.example.com/one",
      nested: {
        user: "https://builder:token@repo.example.com/x",
        password: "do-not-leak",
        deep: [{ secret: "sauce" }, "https://u:p@service.example.com"],
      },
    })).toEqual({
      token: "***",
      message: "https://***@hooks.example.com/one",
      nested: {
        user: "https://***@repo.example.com/x",
        password: "***",
        deep: [{ secret: "***" }, "https://***@service.example.com"],
      },
    });
  });

  it("redacts key-path sensitive values in complex objects", () => {
    expect(redactValue({ token: "abc", safe: "still visible" })).toEqual({
      token: "***",
      safe: "still visible",
    });
  });

  it("leaves ordinary log text alone", () => {
    const text = "TASK [Restart postgresql] ***\nok: [db-02]\n";
    expect(redact(text)).toBe(text);
  });
});

describe("output helpers (design.md §8)", () => {
  it("states the total so an agent never paginates to find it", () => {
    expect(countLine(30, 847)).toBe("30 of 847 total");
    expect(countLine(3, 3)).toBe("3 total");
  });

  it("states the zero with the filter that produced it", () => {
    expect(
      listOutput({
        label: "jobs",
        rows: [],
        count: 0,
        empty: "0 failed jobs in the last 24h",
        help: ["Run `awx-axi job list --status all` for all recent jobs"],
      }),
    ).toEqual({
      jobs: "0 failed jobs in the last 24h",
      help: ["Run `awx-axi job list --status all` for all recent jobs"],
    });
  });

  it("truncates a long field and says how much is missing", () => {
    const result = truncate("x".repeat(1500), 500);

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(1500);
    expect(result.text).toContain("(truncated, 1500 chars total)");
  });

  it("writes a raw log region between an encoded header and an encoded help block", () => {
    const output = rawRegion({
      header: { job_stdout: { id: 1839, lines: "4013-4212 of 4212" } },
      label: "stdout",
      body: "PLAY [db] ***\nfatal: [db-02]: FAILED!\n",
      help: ["Run `awx-axi job events 1839 --failed` for the failing tasks only"],
    });

    expect(output).toBe(
      [
        "job_stdout:",
        "  id: 1839",
        "  lines: 4013-4212 of 4212",
        "stdout:",
        "PLAY [db] ***",
        "fatal: [db-02]: FAILED!",
        "help[1]: Run `awx-axi job events 1839 --failed` for the failing tasks only",
      ].join("\n"),
    );
  });

  it("redacts every log body on the way out", () => {
    const output = rawRegion({
      header: {},
      label: "stdout",
      body: "git fetch https://btsai:s3cr3t@github.com/org/repo\n",
    });

    expect(output).not.toContain("s3cr3t");
  });
});
