# Credential migration

The [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md) supersedes the credential configuration and storage described in the original v1 design.
See [README configuration](../README.md#configuration) for profile examples, environment variables, selection precedence and command usage.

## Migration boundaries

The old token file is never read or automatically imported because it has no controller binding.
The README owns the replacement profile setup, login behavior and legacy environment transition.

`auth logout` sends `DELETE tokens/<stored-id>/` using the stored PAT against its bound origin.
After successful revocation or an upstream 404, the locked deletion removes the local entry only if its id, origin and token still match the revoked credential.
A concurrent replacement is retained and reported in the success output.
See the README for the required write gates.
See [contributing](../CONTRIBUTING.md) for the offline validation boundary and checks.

## Permission verification

Config and stored credentials share the private-file module in `src/core/private-file.ts`.
The README owns the platform permission behavior; tests use injected ACL operations for Windows permission checks.
The published `axi-credential.schema.json` describes one profile and marks the token field with `x-secret: true`.
