<h1 align="center">awx-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/awx-axi"><img alt="npm" src="https://img.shields.io/npm/v/awx-axi?style=flat-square" /></a>
  <img alt="CI" src="https://img.shields.io/badge/CI-not%20configured-lightgrey?style=flat-square" />
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
npx skills add knowttl/awx-axi --skill awx-axi -g
```

Drop `-g` for a project-scoped install with your shell or CLI tooling.

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
configuration-write subcommands - `create`, `edit`, `copy`, and `host-create`/`host-edit` - additionally
require `AWX_AXI_ALLOW_CONFIG_WRITES=1` in the environment, and setting `AWX_AXI_READ_ONLY=1` refuses every
write before anything is sent.

**The mutating examples below are written without `--confirm` on purpose, so every one of them is safe to run
and shows a preview rather than changing anything.** Adding `--confirm` to an example is what performs the
change. Some of these actions cannot be undone - approving a workflow gate releases downstream production
automation - so read the preview before you opt in.

| Domain | Subcommands |
| --- | --- |
| `auth` | `login`, `status`, `logout` |
| `job` | `list`, `show`, `stdout`, `events`, `hosts`, `launch`, `cancel`, `relaunch`, `watch` |
| `template` | `create`, `edit`, `copy`, `list`, `show`, `survey`, `launch` |
| `workflow` | `create`, `edit`, `list`, `show`, `survey`, `launch`, `nodes` |
| `approval` | `list`, `show`, `approve`, `deny` |
| `ad-hoc` | `launch`, `list`, `show`, `events`, `stdout` |
| `project` | `create`, `edit`, `list`, `show`, `playbooks`, `updates`, `roles`, `sync` |
| `inventory` | `create`, `edit`, `sync`, `host-create`, `host-edit`, `list`, `show`, `groups`, `hosts`, `sources`, `updates`, `constructed-list`, `constructed-show` |
| `schedule` | `create`, `edit`, `list`, `show` |
| `system-job` | `list`, `show`, `events`, `notifications` |
| `system-job-template` | `list`, `show` |
| `execution-environment` | `list`, `show` |
| `organization` | `list`, `show` |
| `credential` | `list`, `show` |
| `user` | `list`, `show` |
| `team` | `list`, `show`, `users`, `projects`, `credentials`, `roles`, `object-roles`, `access-list` |
| `role` | `list`, `show`, `parents`, `children`, `users`, `teams` |
| `notification` | `list`, `show` |
| `notification-template` | `list`, `show` |
| `activity-stream` | `list`, `show` |
| `setup` | `hooks` |

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
awx-axi workflow nodes 2048

# ad-hoc commands
awx-axi ad-hoc list --search "sudo apt"
awx-axi ad-hoc show 401
awx-axi ad-hoc events 401 --task "Install packages"
awx-axi ad-hoc stdout 401 --lines 1-200
awx-axi ad-hoc launch Production --module-name ping

# Identity, policy, and approvals
awx-axi organization list
awx-axi credential list --search github-token
awx-axi approval list
awx-axi approval approve 17
awx-axi approval deny 18
awx-axi user list
awx-axi team list
awx-axi team show Engineering
awx-axi team users Engineering
awx-axi role list
awx-axi role show Admin
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
awx-axi schedule list
awx-axi schedule create "Nightly Sync" --rrule "DTSTART:20250101T000000Z RRULE:FREQ=DAILY" --template 12
awx-axi schedule edit "Nightly Sync" --disabled
awx-axi execution-environment list
awx-axi system-job list
awx-axi system-job-template list
```

### TOON output behavior

- List views project to a small schema by default.
- `--fields` lets callers ask for additional keys when needed.
- Pagination is surfaced with `count: N of M total`.
- Empty and partial results use explicit language, so no follow-up query is needed to confirm emptiness.
- Where log output is large, `job stdout` and `ad-hoc stdout` support focused reads with
  `--tail` and `--lines`, and `job stdout` also supports `--download`.
- Errors include suggestions rather than raw service payloads.
- Mutating commands (launch, relaunch, cancel, approve, deny, sync, create, edit, copy) default to a dry run.
  Pass the `--confirm` flag to execute the live mutation request.

## Configuration

awx-axi reads controller and session settings through environment variables.

| Variable | Meaning |
| --- | --- |
| `CONTROLLER_HOST` | Controller base URL, e.g. `https://awx.example.com` |
| `AWX_AXI_API_BASE_PATH` | API path override, default `/api/v2/` |
| `CONTROLLER_OAUTH_TOKEN` | Direct token used for API calls |
| `CONTROLLER_USERNAME` / `CONTROLLER_PASSWORD` | Used by `awx-axi auth login` to mint and save a token |
| `CONTROLLER_VERIFY_SSL` | Set to `false` for self-signed certificates |
| `AWX_AXI_HOME` | Token file directory, default `~/.awx-axi` |
| `AWX_AXI_READ_ONLY` | Set `1` to block mutating commands in non-live contexts |
| `AWX_AXI_ALLOW_CONFIG_WRITES` | Set `1` to allow configuration writes (PUT/PATCH) |
| `AWX_AXI_ALLOW_DELETES` | Set `1` to allow delete operations (DELETE) |
| `AWX_AXI_ALLOW_SECURITY_WRITES` | Set `1` to allow security-sensitive writes |

## Development & Testing

Run the standard build and test pipeline.

```sh
npm run build
npm run typecheck
npm run lint
npm test
```

## License

MIT
