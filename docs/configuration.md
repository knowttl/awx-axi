# Configuration

See [authentication and credentials](credentials.md) for login and private-file permissions, and [the README](../README.md#configuration) for the environment-variable index.

## Paths

Run `awx-axi config path` to print the selected configuration path.
On Linux and macOS, profiles live in `$XDG_CONFIG_HOME/awx-axi/config.json`, defaulting to `~/.config/awx-axi/config.json`.
Stored PATs (`credentials.json`), controller metadata (`controllers/`) and `writes.log` live in `$XDG_STATE_HOME/awx-axi`, defaulting to `~/.local/state/awx-axi`.
Relative XDG roots are ignored.
Windows uses `%APPDATA%\awx-axi` for configuration and `%LOCALAPPDATA%\awx-axi` for state.
If those roots are absent or relative, the defaults are the home directory's `AppData\Roaming\awx-axi` and `AppData\Local\awx-axi`.
`AWX_AXI_WRITE_LOG` overrides the write-journal path.

## Named profiles and SecretRefs

Create `config.json` with private permissions and synthetic values shaped like this:

```json
{
  "version": 1,
  "defaultProfile": "production",
  "profiles": {
    "production": {
      "origin": "https://awx.example.com",
      "verifySsl": true,
      "token": { "env": "PRODUCTION_PAT" }
    }
  }
}
```

Have your secret manager inject `PRODUCTION_PAT`, then run `awx-axi auth status --profile production`.
`awx-axi profile list` lists configured names and origins without resolving secrets.
`awx-axi auth status` reports the selected profile, origin, credential source and identity using at most one controller read.

`token` accepts exactly one reference: `{"env":"NAME"}`, `{"file":"/absolute/private/token"}` or `{"stored":true}`.
Omitting it selects the stored credential keyed by profile name.
Inline tokens are rejected.
Origins cannot contain userinfo, a path other than `/`, a query or a fragment.

## Selection and TLS

Config selection: `--config`, then `AWX_AXI_CONFIG`, then the platform default path.
Profile selection: `--profile`, then `AWX_AXI_PROFILE`, then a complete environment profile, then `defaultProfile`, then the only configured profile.
An incomplete environment profile fails rather than falling back.
File profiles use their own SecretRefs; `AWX_AXI_TOKEN` does not override them.
`--origin` and `--verify-ssl true|false` override the selected profile's origin and TLS verification.
Stored credentials remain bound to their origin and cannot be reused against an overridden origin.

Environment-profile settings apply to that profile, not implicitly to named profiles.
Boolean environment settings accept `1`, `true`, `0` or `false`, case-insensitively, and reject other values.
HTTPS and certificate verification are defaults.
HTTP requires a selected profile's `allowHttp: true` or the environment profile's `AWX_AXI_ALLOW_HTTP=1`.
`auth login --allow-http` opts in and persists that choice after successful login.
`AWX_AXI_API_BASE_PATH` overrides discovery and cached paths; see [compatibility](compatibility.md).

## Migration

Deprecated `CONTROLLER_HOST`, `CONTROLLER_OAUTH_TOKEN`, `CONTROLLER_USERNAME`, `CONTROLLER_PASSWORD` and `CONTROLLER_VERIFY_SSL` map to `AWX_AXI_ORIGIN`, `AWX_AXI_TOKEN`, `AWX_AXI_USERNAME`, `AWX_AXI_PASSWORD` and `AWX_AXI_VERIFY_SSL`, respectively, with stderr notices.
New `AWX_AXI_*` names win when both are set.
`AWX_AXI_HOME` locates the old `token` file only to report a migration diagnostic when the new config is missing; its contents are never read or imported.
The default legacy location is `~/.awx-axi/token`.
See [credential migration boundaries](credentials.md#migration-boundaries).

Renamed flags normally retain a deprecated alias for one minor release.
The former `approval list --all` meaning is now `--include-decided`; `--all` controls pagination only and still defaults to pending approvals.
