# Agent integration

## Session hooks and on-demand skill

Install globally before running `awx-axi setup hooks`.
Setup installs or repairs session-start integrations for Claude Code, Codex and OpenCode; restart the agent session afterward.
Ordinary CLI commands do not install hooks.
Setup verifies installed entries, including the full Codex TOML document and its effective `features.hooks = true` setting, before reporting success.
If any integration fails, setup exits 1 with `HOOK_INSTALL_FAILED` and reports `setup.hooks` as `partial failure` when another integration succeeded, or `failed` when none succeeded.
The error lists each integration's status and affected paths with safe repair guidance, without settings content or parser details.
Repair the reported configuration syntax or write permissions, or move an unmanaged OpenCode plugin aside, then rerun `awx-axi setup hooks`.
Hooks inject the live home dashboard; `npx skills add knowttl/awx-axi --skill awx-axi` installs static guidance on demand.
Add `-g` to the skill-install command for a global skill installation.
The shipped skill uses `npx -y awx-axi` commands so a global binary is optional for skill users.
Neither integration grants AWX permissions or bypasses local write gates.

## Dashboard

The dashboard injects up to five active jobs, five pending approvals and three failures from the last 24 hours.
It makes three bounded list reads after [controller discovery](compatibility.md#discovery-and-cache).
Every home response starts with the executable path (`bin`) and `description`, including missing configuration, authentication, permission, network and TLS failures.
Dashboard errors follow that header with a safe one-line diagnostic and exit 0 to preserve session startup.
Explicit commands retain normal error exits; use `awx-axi doctor` to diagnose access.

## Hook removal

There is no uninstall subcommand.
Delete only the awx-axi-managed SessionStart entries from `~/.claude/settings.json` and `~/.codex/hooks.json`.
Remove the managed OpenCode plugin at `~/.config/opencode/plugins/axi-awx-axi.js`.
Setup also enables Codex hooks in `~/.codex/config.toml`; retain that setting if other hooks use it.
These hook locations come from the pinned SDK and use the home directory supplied by the CLI, independently of skill-discovery overrides.

## Skill discovery

The bare CLI can suggest installing the skill when the current agent host has no detected skill.
Host detection checks `CODEX_THREAD_ID`, then `PI_SESSION_ID`, then `OPENCODE=1`, then `CLAUDECODE=1`.
The first matching host wins; unset markers suppress the hint.
Discovery checks host-specific user/system roots and project skill roots up to the repository boundary.
It changes only the install hint, not controller access or hook installation.

| Variable | Discovery meaning | Default |
| --- | --- | --- |
| `HOME` | Skill-discovery home and controller-cache home fallback | OS home directory |
| `CODEX_HOME` | Additional Codex skill root | `~/.codex` |
| `CLAUDE_CONFIG_DIR` | Claude user skill root | `~/.claude` |
| `OPENCODE_CONFIG_DIR` | Additional OpenCode skill root | Unset |
| `PI_CODING_AGENT_DIR` | Pi skill root; leading `~/` expands | `~/.pi/agent` |
| `ProgramFiles` | Windows managed Claude skill root | `C:\Program Files` |
| `XDG_CONFIG_HOME` | OpenCode user skill root | `~/.config` |

The managed Claude root is `/Library/Application Support/ClaudeCode` on macOS, `%ProgramFiles%\ClaudeCode` on Windows and `/etc/claude-code` on Linux.
