# awx-axi

Inspect and run AWX automation from the shell, for agents and the humans running them.

[![npm](https://img.shields.io/npm/v/@knowttl/awx-axi)](https://www.npmjs.com/package/@knowttl/awx-axi) [![License](https://img.shields.io/github/license/knowttl/awx-axi)](LICENSE) [![Node.js](https://img.shields.io/node/v/@knowttl/awx-axi)](https://nodejs.org/en/download) [![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/@knowttl/awx-axi#provenance) [![AXI](https://img.shields.io/badge/AXI-TOON-blue)](https://github.com/knowttl/artium-axi)

[Why](#why-this-exists) · [Quickstart](#quickstart) · [Agent setup](#use-with-your-agent) · [Coverage](#what-it-covers) · [Safety](#safety) · [Configuration](#configuration) · [Output](#output-and-exit-codes) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Security](#security) · [License](#license)

## Why this exists

Raw AWX REST responses leave agents and the humans running them to guess routes, walk pagination and interpret controller errors.
awx-axi resolves names, bounds TOON output and reports collection completeness so reads can be verified.
Mutation previews and independent write gates make the next action explicit.
Recovery hints help agents act without running an MCP server.

<a id="requirements-and-compatibility"></a>
## Quickstart

Requires Node.js 20 or newer; AWX 24.6.1 is the [compatibility anchor](docs/compatibility.md).
Install and check the CLI:

```sh
npm install --global @knowttl/awx-axi
awx-axi --version
```

Without a global install, use `npx -y @knowttl/awx-axi doctor`.
Have your secret manager inject an existing PAT as `AWX_AXI_TOKEN`, then run:

```sh
export AWX_AXI_ORIGIN=https://awx.example.com
export AWX_AXI_READ_ONLY=1
awx-axi
awx-axi template list --limit 5
```

Synthetic excerpt from the home view (your state will differ):

```text
running[1]{id,name,status,elapsed}:
  42,Example deployment,running,12
```

Use `awx-axi doctor` to verify credential permissions and controller identity.
For named profiles or username/password login, see [authentication and credentials](docs/credentials.md).

## Use with your agent

Install session hooks after the global CLI install, or add the on-demand skill:

```sh
awx-axi setup hooks
npx skills add knowttl/awx-axi --skill awx-axi
```

Hooks inject the live dashboard into Claude Code, Codex and OpenCode sessions; the skill supplies static command guidance.
Neither grants controller permissions; either can be used independently.
Start investigations with the compact [agent guide](docs/agent-guide.md), including read commands, output bounds and failure recovery.
Restart the agent after hook setup and see [SKILL.md](skills/awx-axi/SKILL.md) for command guidance and [the full reference](docs/commands.md) for every command's flags.
To remove hooks, delete only awx-axi-managed entries from `~/.claude/settings.json` and `~/.codex/hooks.json`, and remove `~/.config/opencode/plugins/axi-awx-axi.js`.
See [agent integration](docs/agent-integration.md) for dashboard behavior and the shared Codex setting.

<a id="features"></a>
<a id="commands"></a>
## What it covers

| Groups | Purpose | Access | Reference |
| --- | --- | --- | --- |
| `job`, `ad-hoc` | Inspect runs and logs; launch, cancel and relaunch automation | Read/write | [Jobs](docs/commands.md#job) |
| `template`, `workflow` | Configure and launch automation; inspect workflow nodes | Read/write | [Templates](docs/commands.md#template), [workflows](docs/commands.md#workflow) |
| `approval` | Inspect, approve or deny workflow gates | Read/write | [Approvals](docs/commands.md#approval) |
| `project`, `inventory` | Manage source syncs, hosts, groups and inventory sources | Read/write | [Projects](docs/commands.md#project), [inventories](docs/commands.md#inventory) |
| `host`, `group`, `inventory-source` | Inspect inventory resources, including selected hosts in a bounded batch | Read | [Hosts](docs/commands.md#host), [groups](docs/commands.md#group), [sources](docs/commands.md#inventory-source) |
| `schedule`, `execution-environment` | Manage recurring automation and execution images | Read/write | [Schedules](docs/commands.md#schedule), [images](docs/commands.md#execution-environment) |
| `organization`, `credential`, `user`, `team`, `role` | Manage resources, credentials and access | Read/write | [Organizations](docs/commands.md#organization), [access](docs/commands.md#role) |
| `notification`, `notification-template`, `activity-stream` | Read deliveries and audit events; configure notifications | Read/write | [Notifications](docs/commands.md#notification-template), [audit](docs/commands.md#activity-stream) |
| `system-job`, `system-job-template` | Inspect, launch and cancel maintenance runs | Read/write | [System jobs](docs/commands.md#system-job) |
| `auth`, `doctor`, `config`, `profile`, `setup`, `update` | Configure access, diagnose credentials and install integrations | Local/controller | [Reference](docs/commands.md) |

## Safety

Domain operations are read-only by default: mutations produce previews until `--confirm` is supplied.
`--dry-run` forces a preview even with `--confirm`; previews can read controller data.
Configuration, delete and security writes additionally require their respective `AWX_AXI_ALLOW_*` gates.
Launch-time credential passwords additionally require `AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS=1` and `--credential-passwords-file`.
`AWX_AXI_READ_ONLY=1` blocks every controller write, including login and logout.
`auth login` and `auth logout` act immediately and have no preview or confirmation switch.
Credentials use environment references, private files or protected local state; never put secrets in command arguments or agent chat.
Gates grant no AWX roles and there is no separate CLI resource allowlist; controller RBAC still applies.
See the [write-gate matrix](docs/safety.md#write-gates), [required API permissions](docs/safety.md#permissions) and [credential handling](docs/credentials.md).

## Configuration

Use `awx-axi config path` to locate `config.json` and `awx-axi profile list` to inspect configured profiles without resolving secrets.
Select a named profile with `--profile`; see [configuration](docs/configuration.md) for SecretRef examples, precedence and migration.

| Platform | Default config | Default state |
| --- | --- | --- |
| Linux / macOS | `~/.config/awx-axi/config.json` | `~/.local/state/awx-axi` |
| Windows | `%APPDATA%\awx-axi\config.json` | `%LOCALAPPDATA%\awx-axi` |

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `AWX_AXI_CONFIG`, `AWX_AXI_PROFILE` | Config path and named profile | Platform path; profile selection rules |
| `AWX_AXI_ORIGIN`, `AWX_AXI_TOKEN` | Complete environment profile | Unset |
| `AWX_AXI_USERNAME`, `AWX_AXI_PASSWORD` | Login credentials | Unset |
| `AWX_AXI_VERIFY_SSL`, `AWX_AXI_ALLOW_HTTP` | Environment profile TLS policy | `true`, `false` |
| `AWX_AXI_API_BASE_PATH` | Override discovery and cached API path | `/api/v2/` before discovery |
| `AWX_AXI_WRITE_LOG` | Write journal path | State directory's `writes.log` |
| `AWX_AXI_READ_ONLY` | Block controller writes | `false` |
| `AWX_AXI_ALLOW_CONFIG_WRITES`, `AWX_AXI_ALLOW_DELETES`, `AWX_AXI_ALLOW_SECURITY_WRITES` | Enable each gated write family | `false` |
| `AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS` | Allow launch-time password files | `false` |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Absolute config/state roots on Linux/macOS | `~/.config`, `~/.local/state` |
| `APPDATA`, `LOCALAPPDATA` | Absolute config/state roots on Windows | Home's `AppData\Roaming`, `AppData\Local` |
| `AWX_AXI_HOME` | Locate legacy token for migration diagnostic only | `~/.awx-axi` |
| `CONTROLLER_HOST`, `CONTROLLER_OAUTH_TOKEN`, `CONTROLLER_USERNAME`, `CONTROLLER_PASSWORD`, `CONTROLLER_VERIFY_SSL` | Deprecated aliases of corresponding `AWX_AXI_*` settings | Unset; new names win |
| `CODEX_THREAD_ID`, `PI_SESSION_ID`, `OPENCODE`, `CLAUDECODE` | Detect host for skill-install hint | Unset; OpenCode/Claude require `1` |
| `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `ProgramFiles` | Host paths for skill detection and controller cache | [Path defaults](docs/agent-integration.md#skill-discovery) |

Boolean settings accept `1`, `true`, `0` or `false`, case-insensitively.
Environment-profile TLS and token settings do not override named profiles.

<a id="toon-output-behavior"></a>
<a id="bounded-output"></a>
<a id="errors-and-exit-codes"></a>
## Output and exit codes

See [errors and exits](docs/output.md#errors-and-exits) for stdout, stderr and structured response diagnostics.
Collection commands use `--limit` or bounded `--all`, and report completeness and truncation.
Use `--fields` where command help advertises it; stdout commands offer `--tail` and `--lines` for line slicing.
`job stdout` accepts `--full`, but it does not change the request or bypass truncation.
See [output behavior](docs/output.md) for budgets, continuation caveats and log controls.

| Exit | Meaning |
| --- | --- |
| 0 | Success or no-op; dashboard errors also exit 0 to preserve session startup |
| 1 | Runtime, authentication, permission or safety failure; watched job failed/error/canceled; incomplete host inspection batch without ambiguous selectors |
| 2 | Usage, validation, ambiguous name (including any ambiguous host inspection selector), or launch-input error |

## Troubleshooting

| Code / symptom | Next action |
| --- | --- |
| `PROFILE_REQUIRED` | Configure a profile or inject both `AWX_AXI_ORIGIN` and `AWX_AXI_TOKEN` |
| `AUTH_REQUIRED` | Check the selected credential with `awx-axi auth status` |
| `FORBIDDEN` | Check the account's AWX roles; local gates grant no permissions |
| `INVALID_RESPONSE` | Inspect the [response diagnostics and recovery guidance](docs/output.md#errors-and-exits) |
| `READ_ONLY_VIOLATION` | Keep reads, or unset read-only mode only when writes are intended |
| Dashboard unavailable | Run `awx-axi doctor` for an explicit diagnostic and normal error exit |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, checks and releases, [AGENTS.md](AGENTS.md) for project constraints, and [the design](docs/design.md) for architecture.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE).
