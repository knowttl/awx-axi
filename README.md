# awx-axi

Inspect and run AWX automation from the shell with bounded TOON output for agents and the humans running them.

[![npm](https://img.shields.io/npm/v/awx-axi)](https://www.npmjs.com/package/awx-axi)
[![Node.js](https://img.shields.io/node/v/awx-axi)](https://nodejs.org/en/download)
[![License](https://img.shields.io/github/license/knowttl/awx-axi)](LICENSE)
[![Release provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/awx-axi#provenance)
[![Tested platform](https://img.shields.io/badge/tested-Linux-blue)](#requirements-and-compatibility)

A real CLI response using the repository's synthetic empty-approval fixture:

```text
$ awx-axi approval list
count: 0 total
pagination:
  max_rows: 20
  max_pages: 100
  pages: 1
  stop: complete
  truncated: false
  next: null
  partial_page: false
approvals: 0 approvals pending
help[1]: Run `awx-axi approval list --include-decided` to include approvals that were already decided
```

[Quickstart](#quickstart) • [Use with your agent](#use-with-your-agent) • [Features](#features) • [Safety](#safety) • [Configuration](#configuration) • [Commands](#commands)

## Why this exists

Raw AWX REST responses require callers to manage pagination, project fields and interpret controller errors.
awx-axi provides compact lists, explicit collection budgets, name resolution and structured errors through shell commands.
It works without running an MCP server.

## Features

- **Automation:** inspect, launch, watch, cancel and relaunch jobs; manage workflows and approvals.
- **Management:** configure inventories, templates, projects, schedules, execution environments and notifications.
- **Access:** inspect users, teams and roles; manage credentials, memberships and role assignments.
- **Bounded output:** project fields, limit collection walks and slice job logs.
- **Safety:** preview domain mutations and enforce independent write gates.
- **Agent integration:** install an on-demand skill or a session dashboard hook.

## Requirements and compatibility

| Component | Support evidence |
| --- | --- |
| Node.js | Package requires Node 20 or newer; local validation uses Node 24 on Linux |
| Operating system | Linux tested; macOS and Windows are not validated by this change |
| AWX | 24.6.1 compatibility anchor, verified with offline tagged response fixtures; no live controller validation in this change |
| AAP 2.5+ gateway | Best-effort API-path support; gateway authentication and live compatibility are unverified |

Commands default to `/api/v2/` before discovery.
The first dashboard invocation probes `/api/` and the resolved `ping/`, caching the API path and release in the state directory.
Explicit commands reuse that cache.
Set `AWX_AXI_API_BASE_PATH=/api/controller/v2/` for a gateway path when needed; this does not add gateway token issuance.
The cache has no automatic expiry; remove the corresponding controller cache file after an upgrade to rediscover metadata.

## Quickstart

Install the CLI and have your secret manager inject an existing PAT as `AWX_AXI_TOKEN` into the process environment.
Do not paste tokens or passwords into command arguments or agent chat.

```sh
npm install -g awx-axi
export AWX_AXI_ORIGIN=https://awx.example.com
export AWX_AXI_READ_ONLY=1
awx-axi approval list
```

Replace the example origin with your controller's HTTPS origin.
The empty-controller result has the fixture response's shape above; your counts and rows depend on controller state and permissions.
You can also run `npx -y awx-axi approval list` without installing globally.

For username/password login, configure a named profile under [Configuration](#configuration), then inject `AWX_AXI_USERNAME` and `AWX_AXI_PASSWORD` through your secret manager.
Run `awx-axi auth login --profile production` in a session where read-only mode is unset.
Login immediately mints a write-scoped PAT and stores it privately; it has no preview or `--confirm` switch.
Then use `awx-axi doctor --profile production` to check credential permissions and controller identity.

## Use with your agent

Choose the skill for on-demand guidance or hooks for a dashboard at session startup; either integration can be used independently.

```sh
npx skills add knowttl/awx-axi --skill awx-axi
```

Add `-g` for a global skill installation.
The shipped skill uses `npx -y awx-axi` commands.
The bare CLI can suggest installation when the current agent host has no detected skill.

For session context, install globally first, then:

```sh
awx-axi setup hooks
```

Restart your agent session.
Hooks support Claude Code, Codex and OpenCode and inject up to five active jobs, five pending approvals and three failures from the last 24 hours.
The dashboard makes three bounded list reads after controller discovery.
Dashboard errors produce a safe one-line diagnostic and exit 0; explicit commands retain normal error exits.

To remove hooks, delete only the awx-axi-managed SessionStart entries from `~/.claude/settings.json` and `~/.codex/hooks.json`, and remove `~/.config/opencode/plugins/axi-awx-axi.js`.
Setup also enables Codex hooks in `~/.codex/config.toml`; retain that setting if other hooks use it.
There is no uninstall subcommand.

## Safety

Domain mutations default to previews.
Use `--confirm` to execute; `--dry-run` forces a preview even with `--confirm`.
Previews may perform reads to resolve names and validate input.

| Capability | Required live opt-in |
| --- | --- |
| Launch jobs, workflows, ad-hoc modules and system jobs; sync projects/inventories; cancel/relaunch jobs; approve/deny workflow gates; test notification templates | `--confirm`; no additional operational environment gate |
| Create/edit/copy ordinary configuration; manage labels, instance groups and notification associations | `--confirm` and `AWX_AXI_ALLOW_CONFIG_WRITES=1` |
| Delete configuration resources, users, teams or credentials | `--confirm` and `AWX_AXI_ALLOW_DELETES=1` |
| Create/edit/copy credentials; create/edit users and teams; manage memberships, role assignments, credential associations and user tokens; copy notification templates or create/edit them with secret input | `--confirm` and `AWX_AXI_ALLOW_SECURITY_WRITES=1` |
| `auth login` | Immediate token creation; username/password environment credentials; no confirmation switch |
| `auth logout` | Immediate upstream token revocation and local removal; both delete and security gates; no confirmation switch |
| Block every controller write, including login/logout | `AWX_AXI_READ_ONLY=1` |

Ad-hoc launch runs the supplied module against the target inventory.
Approving a workflow gate can release downstream automation.
Read the preview before confirming either action.

| API permission | Needed for |
| --- | --- |
| PAT with read scope and AWX RBAC visibility | Read commands and dashboard |
| PAT with write scope plus the corresponding resource roles | Launch, approval, management and other confirmed writes |
| Username/password with token-creation permission | `auth login`, which requests scope `write` |

Environment gates do not grant controller permissions.
The controller still enforces RBAC.
Credentials stay in environment references, private files or protected local state.
Secrets are redacted from structured output; resource data and logs can still contain sensitive operational content.
Controller requests send authentication plus requested query parameters or mutation payloads to the selected origin.
Discovery makes unauthenticated metadata reads.
Installation, skill installation and update commands contact their package or source services.
Confirmed writes record method, timestamp and status in the local write journal.

## Configuration

Profiles live in `$XDG_CONFIG_HOME/awx-axi/config.json`, defaulting to `~/.config/awx-axi/config.json`.
Stored PATs and `writes.log` live in `$XDG_STATE_HOME/awx-axi`, defaulting to `~/.local/state/awx-axi`.
Relative XDG roots are ignored.
Windows uses `%APPDATA%\awx-axi` for configuration and `%LOCALAPPDATA%\awx-axi` for state.

<details>
<summary>Named profiles and SecretRefs</summary>

Create the file at the path printed by `awx-axi config path`, with private permissions:

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

`token` accepts exactly one reference: `{"env":"NAME"}`, `{"file":"/absolute/private/token"}` or `{"stored":true}`.
Omitting it selects the stored credential keyed by profile name.
Inline tokens are rejected.
Origins cannot contain userinfo, a path, a query or a fragment.

Config selection: `--config`, then `AWX_AXI_CONFIG`, then the default path.
Profile selection: `--profile`, then `AWX_AXI_PROFILE`, then a complete environment profile, then `defaultProfile`, then the only configured profile.
An incomplete environment profile fails rather than falling back.
File profiles use their own SecretRefs; `AWX_AXI_TOKEN` does not override them.

For stored login, omit the token reference before running `auth login --profile production`.
Explicit environment/file references continue to select those sources after login.
An environment login stores under `env`; add a matching config profile and select it explicitly for later commands.
Stored credentials are bound to their controller origin.
Logout revokes upstream before deleting locally; revocation failures preserve the credential for retry.

POSIX private directories use 0700 and secret files use 0600; 0400 secret files are accepted.
Windows writes use protected DACLs; doctor/status additionally verify those permissions.
Legacy token files are never read.

</details>

| Flag / environment variable / config key | Meaning |
| --- | --- |
| `--config` / `AWX_AXI_CONFIG` | Select config path |
| `--profile` / `AWX_AXI_PROFILE` / `defaultProfile` | Select profile |
| `--origin` / `AWX_AXI_ORIGIN` / `origin` | Controller origin; flag overrides selected profile |
| `AWX_AXI_TOKEN` / `token` | Environment PAT or profile SecretRef |
| `AWX_AXI_USERNAME`, `AWX_AXI_PASSWORD` | Login credentials only |
| `--verify-ssl true\|false` / `AWX_AXI_VERIFY_SSL` / `verifySsl` | TLS verification, default true; flag overrides profile |
| `AWX_AXI_API_BASE_PATH` | Explicit controller API path |
| `AWX_AXI_ALLOW_HTTP` / `allowHttp` | Explicit HTTP opt-in; default false |
| `AWX_AXI_WRITE_LOG` | Override write-journal path |
| `AWX_AXI_READ_ONLY`, `AWX_AXI_ALLOW_CONFIG_WRITES`, `AWX_AXI_ALLOW_DELETES`, `AWX_AXI_ALLOW_SECURITY_WRITES` | Write controls described in [Safety](#safety) |

Environment-profile settings apply to that profile, not implicitly to named profiles.
Boolean environment settings accept `1`, `true`, `0` or `false`, case-insensitively, and reject other values.
HTTPS and certificate verification are defaults.
HTTP requires a selected profile's `allowHttp: true` or the environment profile's `AWX_AXI_ALLOW_HTTP=1`.
`auth login --allow-http` opts in and persists that choice after successful login.

Deprecated `CONTROLLER_HOST`, `CONTROLLER_OAUTH_TOKEN`, `CONTROLLER_USERNAME`, `CONTROLLER_PASSWORD` and `CONTROLLER_VERIFY_SSL` aliases remain for one minor release with stderr notices.
New `AWX_AXI_*` names win when both are set.
Renamed flags normally retain a deprecated alias for one minor release.
The former `approval list --all` meaning is now `--include-decided`; `--all` controls pagination only and still defaults to pending approvals.
Release tags retain the component prefix: `awx-axi-vX.Y.Z`.

## Commands

The table and [full command reference](docs/commands.md) are generated from the built CLI registry and help.
Run `npm run build` then `npm run docs:commands` to regenerate, or append `-- --check` to check for drift.
Use `awx-axi <command> <subcommand> --help` for flags and arguments.

<!-- commands:start -->
| Command | Operations |
| --- | --- |
| `auth` | login, status, logout |
| `doctor` | credential permissions and controller identity |
| `config` | path |
| `profile` | list |
| `setup` | hooks |
| `update` | upgrade; --check reports the latest version |
| `job` | list, show, stdout, events, hosts, launch, cancel, relaunch, watch |
| `template` | object-roles, credential-add, credential-remove, instance-group-add, instance-group-remove, label-add, label-remove, notification-add, notification-remove, create, edit, delete, copy, list, show, survey, launch |
| `workflow` | object-roles, node-create, node-edit, node-delete, node-link, node-unlink, node-credential-add, node-credential-remove, node-label-add, node-label-remove, node-instance-group-add, node-instance-group-remove, node-add-approval, notification-add, notification-remove, label-add, label-remove, copy, create, edit, delete, list, show, survey, launch, nodes, template-nodes, template-node |
| `organization` | create, edit, delete, notification-add, notification-remove, user-add, user-remove, admin-add, admin-remove, team-add, team-remove, instance-group-add, instance-group-remove, execution-environment-add, execution-environment-remove, notification-template-add, notification-template-remove, galaxy-credential-add, galaxy-credential-remove, list, show |
| `system-job-template` | launch, list, show |
| `system-job` | cancel, list, show, events, notifications |
| `credential` | object-roles, copy, create, edit, delete, list, show |
| `approval` | list, show, approve, deny |
| `ad-hoc` | launch, list, show, events, stdout |
| `project` | copy, notification-add, notification-remove, create, edit, delete, list, show, playbooks, updates, roles, sync |
| `inventory` | host-bulk-create, host-bulk-delete, group-create, group-edit, group-delete, group-add-host, group-remove-host, group-add-child, group-remove-child, source-create, source-edit, source-delete, source-credential-add, source-credential-remove, source-notification-add, source-notification-remove, create, edit, delete, sync, host-create, host-edit, host-delete, list, show, groups, hosts, sources, updates, constructed-list, constructed-show |
| `host` | list, show |
| `group` | list, show |
| `inventory-source` | list, show |
| `schedule` | credential-add, credential-remove, label-add, label-remove, instance-group-add, instance-group-remove, create, edit, delete, list, show |
| `execution-environment` | create, edit, delete, copy, list, show |
| `user` | token-create, token-revoke, create, edit, delete, list, show |
| `notification` | list, show |
| `notification-template` | create, edit, delete, test, copy, list, show |
| `activity-stream` | list, show |
| `team` | user-add, user-remove, credential-create, create, edit, delete, list, show, users, projects, credentials, roles, object-roles, access-list |
| `role` | grant, revoke, list, show, parents, children, users, teams |
<!-- commands:end -->

### Bounded output

Native collection commands support `--limit` (1-1,000 rows) or `--all` with optional `--max-rows` (1-10,000; default 10,000), with at most 100 pages.
`--all` conflicts with `--limit`; `--max-rows` requires `--all`.
`--fields`, where advertised by command help, selects additional fields.
Launch commands use `--limit` as an Ansible host pattern instead.

Pagination reports budgets, pages read, stop reason, truncation and server continuation.
When `partial_page: true`, following `next` skips undisplayed rows from that page; rerun the filtered command with a larger budget instead.
Detail aggregates read complete collections independently and fail with `INCOMPLETE_COLLECTION` if continuation stalls.
`inventory updates` reports source pagination and per-source truncation without inventing a combined server total.
`workflow template-node` reads complete credentials and edge collections and accepts no row limit.

Job and ad-hoc stdout support `--tail` and `--lines`; job stdout also supports `--download`.
Empty results are explicit.
TOON data, errors and recovery suggestions go to stdout; diagnostics go to stderr.

### Errors and exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success, including no-op results; dashboard failures deliberately exit 0 to preserve session startup |
| 1 | Runtime, authentication, permission or safety failure; also a watched job ending failed/error/canceled |
| 2 | Usage or validation error, ambiguous name, ignored launch input or required launch input |

Errors expose `error`, `code` and recovery `help` where available.
For `PROFILE_REQUIRED`, configure an origin and SecretRef or inject the complete environment profile.
For `AUTH_REQUIRED`, check the selected credential; for `FORBIDDEN`, check the account's AWX roles.
Use `awx-axi doctor` to inspect the selected identity and credential permissions.

## Contributing

Use Node.js 20 or newer and install locked dependencies with `npm ci`.
Run the required local checks:

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm run docs:commands -- --check
```

Hosted PR test CI is not used.
The default tests use offline transports and synthetic fixtures.
See [CONTRIBUTING.md](CONTRIBUTING.md) for isolated test environments and contribution guidance.
Generated skill copies are checked by the default test suite.

## License

[MIT](LICENSE).

If this project saved you time or helped your workflow, please consider giving it a ⭐ on GitHub to help others find it!
