# Authentication and credentials

The [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md) supersedes the credential configuration and storage described in the original v1 design.
See [configuration](configuration.md) for profile examples, environment variables and selection precedence, and [command help](commands.md#auth) for authentication commands.

## Existing PAT

Have a secret manager inject an existing PAT as `AWX_AXI_TOKEN` and set `AWX_AXI_ORIGIN` to your controller's HTTPS origin.
Do not paste tokens or passwords into command arguments or agent chat.
Use `AWX_AXI_READ_ONLY=1` for sessions that must never write to the controller.
For named profiles, select an environment, private file or stored SecretRef as described in [configuration](configuration.md#named-profiles-and-secretrefs).

## Username/password login

Configure a named profile with an origin and omit its token reference, then inject `AWX_AXI_USERNAME` and `AWX_AXI_PASSWORD` through your secret manager.
Run `awx-axi auth login --profile production` in a session where read-only mode is unset.
Login immediately mints a write-scoped PAT and stores it privately; it has no preview or `--confirm` switch.
Then use `awx-axi doctor --profile production` to check credential permissions and controller identity.

For stored login, omit the token reference before running login.
Explicit environment/file references continue to select those sources after login.
An environment login stores under `env`; add a matching config profile and select it explicitly for later commands.
Stored credentials are bound to their controller origin.
Logout revokes upstream before deleting locally; revocation failures preserve the credential for retry.

## Migration boundaries

The old token file is never read or automatically imported because it has no controller binding.
[Configuration](configuration.md) owns profile setup and the legacy environment transition; this document owns authentication behavior.

`auth logout` sends `DELETE tokens/<stored-id>/` using the stored PAT against its bound origin.
After successful revocation or an upstream 404, the locked deletion removes the local entry only if its id, origin and token still match the revoked credential.
A concurrent replacement is retained and reported in the success output.
See [safety](safety.md#write-gates) for the required write gates.
See [contributing](../CONTRIBUTING.md) for the offline validation boundary and checks.

## Permission verification

Config and stored credentials share the private-file module in `src/core/private-file.ts`.
POSIX private directories use 0700 and secret files use 0600; 0400 secret files are accepted.
Windows writes use protected DACLs; doctor/status additionally verify those permissions.
Tests use injected ACL operations for Windows permission checks.
Native Windows config writes and `auth status` verification remain recommended before release; controller access requires separate authorization under the validation boundary in CONTRIBUTING.md.
The published `axi-credential.schema.json` describes one profile and marks the token field with `x-secret: true`.
