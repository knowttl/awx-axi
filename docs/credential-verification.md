# Credential migration verification plan

## Intent and scope

Implement the agreed AXI credential standard for awx-axi.
The migration closes I-01, I-02, I-04, I-05, I-06, I-09, I-10 and I-16 from the credential audit.
The public contract is https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md.
Plain HTTP remains refused pending an owner decision about an explicit exception.

## Verification

Run every repository command with temporary HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, APPDATA and LOCALAPPDATA.
Use only offline transports and fake network boundaries.
Never run live tests, contact a real controller, read real credentials, mint a real PAT or revoke a real PAT.

1. Run `npm run build`, `npm run typecheck`, `npm run lint` and `npm test`.
2. Verify profile selection precedence, strict schema validation, default and explicit SecretRefs, deprecated environment aliases and incomplete environment rejection.
3. Verify config and state paths on POSIX and with injected Windows platform settings.
4. Verify atomic private-file replacement, ownership, mode checks, symlink rejection and failure cleanup using temporary files.
5. Verify the Windows branch with injected ACL operations: protect directories and temporary files before writing secrets, skip POSIX modes, verify DACLs explicitly and retry transient rename failures with bounded backoff.
6. Exercise login, status and logout through the CLI with RecordedTransport; verify origin binding, read-only gates, revoke-before-delete and retention after failed revocation.
7. Verify isolated TLS agents and refusal to send credentials through cross-origin pagination links or followed redirects.
8. Verify exact-secret and encoded-secret redaction in rendered output and errors.
9. Pack and install the CLI into a temporary directory; verify the shipped credential schema and executable help.

Windows DACL behavior is verified only with fakes on this Linux host.
A native Windows config write and `auth status` run remain recommended before release.
