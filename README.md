<h1 align="center">awx-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/awx-axi"><img alt="npm" src="https://img.shields.io/npm/v/awx-axi?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/axi"><img alt="AXI" src="https://img.shields.io/badge/AXI-Agent%20eXperience%20Interface-green?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/knowttl/awx-axi?style=flat-square" /></a>
</p>

AWX CLI for agents — designed with AXI (Agent eXperience Interface).

awx-axi is built for shell execution by autonomous agents.
It emits token-efficient TOON, adds contextual next-step suggestions, and keeps errors machine-readable on stdout.

## Benchmarks & Agent Ergonomics

- Token-efficient output with TOON saves around 40% of tokens versus raw JSON in list-heavy flows.
- Minimal default schemas on list views keep each row small and actionable.
- Every empty list returns a definitive state instead of ambiguous silence.
- Large content paths include explicit escape hatches, such as line slicing and download options.
- Structured errors stay on stdout as `error`, `code`, and `help` hints, with exit codes that distinguish usage from runtime failures.

## Quick Start

### Skill installation

Install the AWX skill using `npx skills`.

```sh
npx skills add knowttl/awx-axi --skill awx-axi
```

Add `-g` for a global install instead of a project-scoped install.

Running `awx-axi` with no arguments in Codex, Claude Code, OpenCode, or Pi shows a one-line hint with this install command when the skill is missing for that host.
The hint disappears when an installation is found in a supported location and is omitted outside recognized agent hosts.

Detection checks each host's default roots, skills CLI destinations, documented root environment overrides, and Claude's conditional main-checkout worktree fallback, looking only for a direct `awx-axi/SKILL.md` child of each root.
It uses file-existence checks, plus `.git` and `commondir` reads for that fallback, with no network requests, subprocesses, settings-file parsing, or recursive skill-tree walks.
Settings-listed skill paths and nested layouts are not detected, so those installations may still produce the extra hint line.

This is the fastest setup path for agent workflows.
The skill points agents to run commands as `npx -y awx-axi`.

### Zero setup

For any environment that already has Node, run commands directly with no local install.

```sh
npx -y awx-axi
```

For commands that include follow-up suggestions, keep using `npx -y awx-axi` in each step.

## Other ways to install

### Global install and session hooks

Use session hooks when you want AWX context on every agent session start.

```sh
npm install -g awx-axi
awx-axi setup hooks
```

This installs optional integration hooks for Claude Code, Codex, and OpenCode.
The bare `awx-axi` command and session hooks show up to 5 active jobs, 5 pending approvals, and 3 failures from the last 24 hours using three bounded list reads.
The controller header includes the AWX release discovered from `ping/`.
On first use, `/api/` discovers the API path unless `AWX_AXI_API_BASE_PATH` overrides it, and `ping/` reads the release without credentials.
These two values are cached together under the tool's state directory in `controllers/`, separately for each origin and API-path override; later home invocations need only the three list reads.
Quiet controllers show explicit zero states.
Dashboard failures print a safe, single-line diagnostic and exit 0 so session startup can continue; explicit commands retain their normal errors and exit codes.
Home cancels outstanding network requests after eight seconds, before the hooks' ten-second timeout.
Restart your agent session after running `awx-axi setup hooks` so the hook is active.

### Direct install

Using the global package is also fine for direct command entry.

```sh
npm install -g awx-axi
awx-axi auth status
```

## Usage

awx-axi output is TOON-first.
List commands use compact default schemas with explicit `count:` summaries.
Detail views stay compact and add `help:` suggestions when follow-up work is likely.

```sh
count: 20 of 143 total
jobs[20]{id,status,start}
```

The `count` line is definitive.
`show` and `watch` style detail output keep the first pass short and useful.

### Command surface and subcommands

This is the shipped command surface.
All core AWX domains are available and return only one noun per operation.

**Every mutating subcommand refuses to mutate by default.** Without `--confirm` it prints a preview of exactly
what it would send and changes nothing; `--dry-run` forces that preview even when `--confirm` is passed. The
ordinary configuration mutations require `AWX_AXI_ALLOW_CONFIG_WRITES=1`, delete subcommands require
`AWX_AXI_ALLOW_DELETES=1`, and security-sensitive subcommands require `AWX_AXI_ALLOW_SECURITY_WRITES=1` in the
environment. Setting `AWX_AXI_READ_ONLY=1` refuses every write before anything is sent.

**The mutating examples below are written without `--confirm` on purpose, so every one of them is safe to run
and shows a preview rather than changing anything.** Adding `--confirm` to an example is what performs the
change. Some of these actions cannot be undone - approving a workflow gate releases downstream production
automation - so read the preview before you opt in.

| Domain | Subcommands |
| --- | --- |
| `auth` | `login`, `status`, `logout` |
| `job` | `list`, `show`, `stdout`, `events`, `hosts`, `launch`, `cancel`, `relaunch`, `watch` |
| `template` | `create`, `edit`, `copy`, `delete`, `list`, `show`, `object-roles`, `survey`, `launch`, credential/instance-group/label/notification associations |
| `workflow` | `create`, `edit`, `copy`, `delete`, `list`, `show`, `object-roles`, `survey`, `launch`, `nodes` (workflow runs), `template-nodes`/`template-node` (editable templates), template labels and notifications, node and edge management |
| `approval` | `list`, `show`, `approve`, `deny` |
| `ad-hoc` | `launch`, `list`, `show`, `events`, `stdout` |
| `project` | `create`, `edit`, `copy`, `delete`, `list`, `show`, `playbooks`, `updates`, `roles`, `sync`, notification associations |
| `inventory` | `create`, `edit`, `delete`, `sync`, host CRUD and bulk operations, group topology, source management, `list`, `show`, `groups`, `hosts`, `sources`, `updates`, `constructed-list`, `constructed-show` |
| `host` | `list`, `show` across all visible inventories and organizations |
| `group` | `list`, `show` with direct hosts, child groups, and variables |
| `inventory-source` | `list`, `show` with safe configuration and direct update history |
| `schedule` | `create`, `edit`, `delete`, `list`, `show`, credential/label/instance-group associations |
| `system-job` | `cancel`, `list`, `show`, `events`, `notifications` |
| `system-job-template` | `launch`, `list`, `show` |
| `execution-environment` | `create`, `edit`, `copy`, `delete`, `list`, `show` |
| `organization` | `create`, `edit`, `delete`, `list`, `show`, membership, execution, credential, and notification associations |
| `credential` | `create`, `edit`, `copy`, `delete`, `list`, `show`, `object-roles` |
| `user` | `create`, `edit`, `delete`, `token-create`, `token-revoke`, `list`, `show` |
| `team` | `create`, `edit`, `delete`, `credential-create`, `user-add`, `user-remove`, `list`, `show`, `users`, `projects`, `credentials`, `roles`, `object-roles`, `access-list` |
| `role` | `grant`, `revoke`, `list`, `show`, `parents`, `children`, `users`, `teams` |
| `notification` | `list`, `show` |
| `notification-template` | `create`, `edit`, `copy`, `delete`, `test`, `list`, `show` |
| `activity-stream` | `list`, `show` |
| `setup` | `hooks` |

System jobs, notifications, and activity-stream entries are generated records rather than configuration resources.
System jobs support cancellation, and built-in system job templates support launch, but AWX exposes no CRUD operations for those records.
Notifications and activity-stream entries remain read-only.

```sh
# Auth and setup
awx-axi auth status
awx-axi setup hooks

# Unified jobs
awx-axi job list --status running
awx-axi job show 1839
awx-axi job stdout 1839 --tail 200
awx-axi job events 1839 --failed
awx-axi job hosts 1839
awx-axi job launch deployment-template --wait
awx-axi job relaunch 1839 --failed-only
awx-axi job watch 1839

# Templates and workflows
awx-axi template list --search deploy
awx-axi template show deployment-template
awx-axi template survey deployment-template
awx-axi template launch deployment-template --wait
awx-axi template create "Deploy Web Tier" --inventory Production --project AppRepo
awx-axi template edit deployment-template --name "New Name"
awx-axi template copy deployment-template --name "Copy Name"
awx-axi workflow list
awx-axi workflow show workflow-template
awx-axi workflow survey workflow-template
awx-axi workflow launch workflow-template --wait
awx-axi workflow create "Release Workflow"
awx-axi workflow edit workflow-template --description "My workflow"
awx-axi workflow node-create workflow-template --template deployment-template
awx-axi workflow template-nodes workflow-template
awx-axi workflow template-node 71
awx-axi workflow nodes 2048

# ad-hoc commands
awx-axi ad-hoc list --search "sudo apt"
awx-axi ad-hoc show 401
awx-axi ad-hoc events 401 --task "Install packages"
awx-axi ad-hoc stdout 401 --lines 1-200
# ad-hoc launch executes an operator-supplied module on every host in the inventory.
# As written this previews only; adding --confirm runs it, and a command run cannot be undone.
awx-axi ad-hoc launch Production --module-name ping

# Identity, policy, and approvals
awx-axi organization list
awx-axi organization create Operations
awx-axi organization user-add Operations --user alice
awx-axi credential list --search github-token
awx-axi credential create "AWS Credential" --credential-type "Amazon Web Services"
awx-axi credential edit "AWS Credential" --description "Updated key"
awx-axi credential delete "AWS Credential"
awx-axi approval list
awx-axi approval approve 17
awx-axi approval deny 18
awx-axi user list
awx-axi user create alice --password-file /path/to/pass
awx-axi user edit alice --email alice@example.com
awx-axi user delete alice
awx-axi team list
awx-axi team show Engineering
awx-axi team create Engineering --organization Default
awx-axi team edit Engineering --description "Dev Team"
awx-axi team delete Engineering
awx-axi team users Engineering
awx-axi role list
awx-axi role show Admin
awx-axi role grant Admin --user alice
awx-axi role revoke Admin --user alice
awx-axi role parents Admin

# Projects, inventories, and schedules
awx-axi project list
awx-axi project show main-project
awx-axi project playbooks main-project
awx-axi project updates main-project
awx-axi project roles main-project
awx-axi project sync main-project --wait
awx-axi project create "App Deploy" --scm-type git --scm-url https://github.com/...
awx-axi project edit main-project --description "New Description"
awx-axi inventory list
awx-axi inventory show base-inventory
awx-axi inventory groups base-inventory
awx-axi inventory hosts base-inventory --facts
awx-axi inventory sources base-inventory
awx-axi inventory updates base-inventory
awx-axi inventory constructed-list
awx-axi inventory constructed-show dynamic-inventory
awx-axi inventory create Production --organization Default
awx-axi inventory edit base-inventory --description "Updated description"
awx-axi inventory sync base-inventory --wait
awx-axi inventory host-create web-01 --inventory Production
awx-axi inventory host-edit web-01 --disabled
awx-axi host list --search web --inventory 11
awx-axi host show web-01
awx-axi group list --inventory 11
awx-axi group show web
awx-axi inventory-source list --source ec2 --status successful
awx-axi inventory-source show "Nightly EC2 sync"
awx-axi inventory group-create web --inventory Production
awx-axi inventory source-create cloud --inventory Production --source ec2
awx-axi schedule list
awx-axi schedule create "Nightly Sync" --rrule "DTSTART:20250101T000000Z RRULE:FREQ=DAILY" --template 12
awx-axi schedule edit "Nightly Sync" --disabled
awx-axi execution-environment list
awx-axi execution-environment create base --image quay.io/example/base
awx-axi notification-template test 7
awx-axi system-job cancel 44
awx-axi system-job-template launch cleanup-jobs
```

### TOON output behavior

`approval list` defaults to pending approvals and at most 20 rows.
Use `awx-axi approval list --include-decided --limit 50` to include approved or denied approvals within that row limit.
The former `approval list --all` spelling now fails with exit 2 and a migration hint before any request.
Replace it with `--include-decided`, keeping any `--limit` value.
Renamed flags normally retain a deprecated alias for one minor release.
This collision is an explicit exception: `--all` is reserved for future pagination, so retaining the old runtime alias would make its meaning ambiguous.
Pagination via `approval list --all` is not enabled during this transition.

- List views project to a small schema by default.
- `--fields` lets callers ask for additional keys when needed.
- Pagination is surfaced with `count: N of M total`.
- Empty and partial results use explicit language, so no follow-up query is needed to confirm emptiness.
- Where log output is large, `job stdout` and `ad-hoc stdout` support focused reads with
  `--tail` and `--lines`, and `job stdout` also supports `--download`.
- Errors include suggestions rather than raw service payloads.
- Every mutating command defaults to a dry run.
  Pass the `--confirm` flag to execute the live mutation request.
- `ad-hoc launch` runs an operator-supplied module on every host in the target inventory, so it is the sharpest
  command here. It previews like the rest and needs `--confirm` to act, but no dedicated environment gate covers
  it, and `AWX_AXI_READ_ONLY=1` is what refuses it outright.

## Configuration

awx-axi follows the [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md).
Profiles live in `$XDG_CONFIG_HOME/awx-axi/config.json`, or `~/.config/awx-axi/config.json` when XDG is unset or relative.
On Windows, XDG is ignored and config lives under `%APPDATA%\awx-axi`.
Stored PATs and `writes.log` live under `$XDG_STATE_HOME/awx-axi`, defaulting to `~/.local/state/awx-axi`, or `%LOCALAPPDATA%\awx-axi` on Windows.
Home paths use the operating system's home directory.

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

`token` accepts exactly one SecretRef: `{"env":"NAME"}`, `{"file":"/absolute/private/path"}`, or `{"stored":true}`.
An omitted token ref uses the stored credential keyed by that profile's name, equivalent to `{"stored":true}`.
Use an explicit `{"env":"AWX_AXI_TOKEN"}` ref for a file profile that should read its token from that variable.
Inline tokens are rejected without printing their values.
Origins must have no userinfo, path, query or fragment.

Select config with `--config`, then `AWX_AXI_CONFIG`, then the default path.
Select a profile with `--profile`, then `AWX_AXI_PROFILE`, then a complete environment profile, then `defaultProfile`, then the only profile.
An environment profile requires `AWX_AXI_ORIGIN` plus `AWX_AXI_TOKEN`, or both login credentials for `auth login`.
An incomplete environment profile fails instead of falling back to another profile.
File-selected profiles use their own settings and SecretRefs.
Non-secret flags `--origin` and `--verify-ssl true|false` override the selected profile.
HTTPS is the default.
Plain HTTP requires `"allowHttp": true` on the selected profile, or `AWX_AXI_ALLOW_HTTP=1` for the environment profile.
`auth login --allow-http` explicitly permits HTTP for that login and saves `allowHttp: true` in the selected profile after successful login.
This is the only login option that writes profile config; on an existing profile it changes only `allowHttp`, preserving the saved origin, TLS verification setting and token ref.
For an environment login without a configured `env` profile, it creates that profile with the effective origin and settings and a stored token ref.
The opt-in applies only to that profile.
Constructing a transport for a plain HTTP controller prints a one-line stderr warning because credentials and traffic are unencrypted.

`awx-axi config path` prints the config location.
`awx-axi profile list` lists names and origins without resolving secrets.
`awx-axi auth status` reports profile, origin, credential source and identity using one live read.
`awx-axi doctor` performs the same bounded identity and credential permission check.
`awx-axi auth login` mints a PAT and saves its id, origin and token in protected state `credentials.json`, keyed by profile name.
Configure a named profile with its controller origin and omit its token ref before running `auth login --profile <name>`.
After login, that profile uses its origin-bound stored PAT; explicit SecretRefs continue to select their declared sources.
An environment login stores under `env`; unless using `--allow-http`, add that profile to config yourself and select it with `--profile env` for subsequent commands while login environment variables remain set.
If an implicit environment login would replace a configured or stored `env` identity bound to another controller, it fails before minting and requires an explicit configured profile name.
`awx-axi auth logout` revokes that PAT upstream before removing it locally, requiring `AWX_AXI_ALLOW_DELETES=1` and `AWX_AXI_ALLOW_SECURITY_WRITES=1` and respecting read-only mode.
Revocation failures preserve the local PAT for retry.
Stored tokens cannot be used after an origin change.

Files are written atomically and read only after ownership, type and permissions checks.
POSIX directories use 0700 and secrets use 0600, with read-only 0400 secrets also accepted.
Windows writes apply protected DACLs for the current account, SYSTEM and Administrators.
Ordinary Windows reads reject reparse points; `auth status` and `doctor` also verify DACLs.
TLS verification changes apply only to the selected transport.
The old `~/.awx-axi/token` and `$AWX_AXI_HOME/token` are never read.
When only a legacy token exists, `CONFIG_MOVED` names the new path and profile format.

| Variable | Meaning |
| --- | --- |
| `AWX_AXI_CONFIG` / `AWX_AXI_PROFILE` | Config file path / selected profile |
| `AWX_AXI_ORIGIN` | Controller origin for the environment profile, HTTPS by default |
| `AWX_AXI_ALLOW_HTTP` | Environment profile HTTP opt-in, default false; accepts `1`/`true` or `0`/`false`, rejects other values |
| `AWX_AXI_API_BASE_PATH` | API path override, default `/api/v2/` |
| `AWX_AXI_TOKEN` | Direct token used by the environment profile or an explicit env SecretRef |
| `AWX_AXI_USERNAME` / `AWX_AXI_PASSWORD` | Used only by `auth login` |
| `AWX_AXI_VERIFY_SSL` | Environment profile TLS verification, default `true` |
| `AWX_AXI_WRITE_LOG` | Write journal path override |
| `AWX_AXI_READ_ONLY` | Set `1` or `true` to block mutating commands |
| `AWX_AXI_ALLOW_CONFIG_WRITES` | Set `1` to allow configuration-tagged mutations |
| `AWX_AXI_ALLOW_DELETES` | Set `1` to allow delete-tagged mutations |
| `AWX_AXI_ALLOW_SECURITY_WRITES` | Set `1` to allow security-sensitive writes |

Boolean environment settings accept `1`, `true`, `0` or `false`, case-insensitively; other values fail closed.
For one minor release, `CONTROLLER_HOST`, `CONTROLLER_OAUTH_TOKEN`, `CONTROLLER_USERNAME`, `CONTROLLER_PASSWORD` and `CONTROLLER_VERIFY_SSL` remain deprecated aliases with stderr notices.
These aliases will be removed after that one-minor-release transition; migrate to the `AWX_AXI_*` names now.
The new names win when both are set.
Legacy file paths have no transition period.

## Development & Testing

Validation runs locally rather than through hosted PR test CI.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the required checks, setup, and offline testing guidance.

## License

MIT
