# Credential migration

The [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md) supersedes the credential configuration and storage described in the original v1 design.
See the README configuration section for profile examples, environment variables and command usage.

## Migration boundaries

The old token file is never read or automatically imported because it has no controller binding.
Create a profile with an HTTPS origin and an environment or private-file SecretRef, or use `auth login` to mint an origin-bound PAT.
Login writes only protected state credentials and never config.
A profile with no token ref uses its stored credential by profile name; explicit SecretRefs retain their declared sources.
Implicit environment login refuses collisions with configured or stored identities bound to another controller before minting.
Legacy environment variables remain aliases for one minor release with stderr notices.
Plain-HTTP controllers are refused pending an owner decision about an explicit exception.
`verifySsl: false` changes certificate verification only for the selected transport and does not allow HTTP.

`auth logout` sends `DELETE tokens/<stored-id>/` using the stored PAT against its bound origin.
Only successful revocation or an upstream 404 removes the local entry.
Read-only mode and the delete gate apply before revocation.
No migration verification may contact a real controller or mint a real PAT.

## Permission verification

Config and stored credentials share the private-file module in `src/core/private-file.ts`.
POSIX tests exercise ownership, permission bits, symlinks, atomic replacement and cleanup through the real filesystem.
Windows tests inject ACL operations and transient rename failures on Linux.
They verify DACL application before secret content is written, mode-bit independence, explicit DACL verification and bounded rename retries.
Native PowerShell DACL behavior remains unverified on this Linux development host.
A real Windows config write and `auth status` run are recommended before release.

`auth status` and `doctor` verify the selected config and secret file DACLs before making their bounded identity read.
Ordinary Windows commands check file type and reparse points without querying the DACL.
The published `axi-credential.schema.json` describes one profile and marks the token field with `x-secret: true`.
