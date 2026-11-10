/**
 * Redaction of log output (design.md §6.4).
 *
 * AWX applies `UriCleaner.remove_sensitive` to project-update output **only on
 * the download renderer**, not on the ordinary `txt`, `ansi`, or `json` stdout
 * paths awx-axi reads. So awx-axi redacts on the way to stdout itself rather
 * than trusting the controller to have done it.
 */
import { parse as parseYaml } from "yaml";

/**
 * Credentials embedded in an SCM URL: `https://user:token@github.com/org/repo`.
 * Both the userinfo and the whole `user:pass` pair go, since a bare username in
 * a clone URL is often the token itself.
 */
const SCM_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** AWX's own marker for a value it already replaced, plus anything trailing it. */
const ENCRYPTED = /\$encrypted\$[^\s"'&]*/g;

export const REDACTION = "***";

const secrets = new Map<string, boolean>();
const trustedFields = new WeakMap<object, ReadonlySet<string>>();

export function registerSecret(secret: string): void {
  if (secret.length === 0) return;
  for (const representation of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
    secrets.set(representation, secrets.get(representation) === true || secret.length >= 8);
  }
}

export function registerSecretValues(value: unknown): void {
  if (typeof value === "string") registerSecret(value);
  else if (typeof value === "number" || typeof value === "boolean") registerSecret(String(value));
  else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) registerSecretValues(entry);
  }
}

export function clearSecrets(): void { secrets.clear(); }

/** Redact one log body. Applied to every log body awx-axi prints. */
export function redact(text: string): string {
  let safe = text;
  for (const [secret, long] of [...secrets].sort(([a], [b]) => b.length - a.length)) {
    if (long) safe = safe.replaceAll(secret, REDACTION);
    else {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      safe = safe.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"), REDACTION);
    }
  }
  return safe
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, REDACTION)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTION)
    .replace(/\bAccountKey=[^;\s]+/gi, `AccountKey=${REDACTION}`)
    .replace(/([?&]sig=)[^&\s]+/gi, `$1${REDACTION}`)
    .replace(SCM_CREDENTIAL, `$1${REDACTION}@`)
    .replace(ENCRYPTED, "$encrypted$");
}

/**
 * The one structural choke point for printed data (design.md §6.4).
 *
 * Every domain result, error and dry-run preview is redacted here, by walking
 * the value rather than substring-replacing the encoded text, so keys and the
 * keys survive a registered secret that happens to equal them.
 * - string values pass through `redact` for URLs and `$encrypted$`
 * - values under secret keys are registered, then replaced with `***`
 * - serialized `extra_vars` holding a secret key are replaced whole
 * - arrays and objects are walked recursively
 */
const SENSITIVE_KEY = /(password|api[-_]?key|access[-_]?key|private[-_]?key|ssh[-_]?key[-_](?:data|unlock)|secret|token|passphrase|notification[-_]configuration|authorization$)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function hasSensitiveKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => isSensitiveKey(key) || hasSensitiveKey(entry));
}

function redactExtraVars(text: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    registerSecret(text);
    return REDACTION;
  }
  if (!hasSensitiveKey(parsed)) return redact(text);
  redactValue(parsed);
  registerSecret(text);
  return REDACTION;
}

export function redactValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return key === "extra_vars" ? redactExtraVars(value) : redact(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key));
  if (value === null || typeof value !== "object") return value;
  const credential = "credential_type" in value;
  const trusted = trustedFields.get(value);
  const result = Object.fromEntries(Object.entries(value).map(([field, raw]) => {
    if (trusted?.has(field)) return [field, raw];
    if (!isSensitiveKey(field) && !(credential && field === "inputs")) return [field, redactValue(raw, field)];
    registerSecretValues(raw);
    return [field, REDACTION];
  }));
  if (trusted) trustedFields.set(result, trusted);
  return result;
}

export function trustFields<T extends object>(value: T, fields: readonly string[]): T {
  trustedFields.set(value, new Set(fields));
  return value;
}

export function registerSensitiveValues(value: unknown): void {
  redactValue(value);
}

export function redactResult(result: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof result === "string") return redact(result);
  registerSensitiveValues(result);
  return Object.fromEntries(Object.entries(result).map(([label, section]) => [label, redactValue(section, label)]));
}
