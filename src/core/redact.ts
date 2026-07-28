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
