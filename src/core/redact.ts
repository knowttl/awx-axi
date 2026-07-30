/**
 * Redaction of log output (design.md §6.4).
 *
 * AWX applies `UriCleaner.remove_sensitive` to project-update output **only on
 * the download renderer**, not on the ordinary `txt`, `ansi`, or `json` stdout
 * paths awx-axi reads. So awx-axi redacts on the way to stdout itself rather
 * than trusting the controller to have done it.
 */

/**
 * Credentials embedded in an SCM URL: `https://user:token@github.com/org/repo`.
 * Both the userinfo and the whole `user:pass` pair go, since a bare username in
 * a clone URL is often the token itself.
 */
const SCM_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** AWX's own marker for a value it already replaced, plus anything trailing it. */
const ENCRYPTED = /\$encrypted\$[^\s"'&]*/g;

export const REDACTION = "***";

/** Redact one log body. Applied to every log body awx-axi prints. */
export function redact(text: string): string {
  return text
    .replace(SCM_CREDENTIAL, `$1${REDACTION}@`)
    .replace(ENCRYPTED, "$encrypted$");
}

/**
 * Recursively redact values that look sensitive before they reach detail/list output.
 *
 * AWX does not redact nested payloads in every endpoint. We sanitize object
 * values in a conservative way:
 * - string values pass through `redact` for URLs and `$encrypted$`
 * - keys that look secret are replaced with `***`
 * - arrays and objects are walked recursively
 */
const SENSITIVE_KEY = /(password|api[-_]?key|secret|token|passphrase)/i;

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redact(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = REDACTION;
      } else {
        output[key] = redactValue(raw);
      }
    }
    return output;
  }
  return value;
}
