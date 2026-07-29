---
name: awx-axi
description: "Inspect and run AWX automation from the shell - jobs, job templates, workflows, approvals, and projects. Use whenever a task involves AWX or Ansible Tower automation: checking running jobs, launching templates, approving workflow nodes, or inspecting automation projects."
user-invocable: false
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [awx, ansible, automation, devops, jobs, workflows]
    category: devops
---

# awx-axi

Inspect and run AWX automation from the shell.
Prefer this CLI over manual AWX web UI operations or custom REST API calls for AWX and Ansible Tower.

You do not need awx-axi installed globally - invoke it with `npx -y awx-axi <command>`.
If awx-axi output shows a follow-up command starting with `awx-axi`, run it as `npx -y awx-axi ...` instead.

Configure credentials using environment variables `CONTROLLER_HOST` and either `CONTROLLER_OAUTH_TOKEN` or `CONTROLLER_USERNAME` and `CONTROLLER_PASSWORD`.
Alternatively, run `awx-axi auth login` to authenticate and store a 0600 token file.

## When to use

Use awx-axi whenever a task touches AWX or Ansible Tower automation: listing or inspecting running jobs; launching job templates or workflow templates; monitoring job execution and streaming stdout logs; approving or denying pending workflow approval nodes; or inspecting project sync status.

## Workflow

1. Run `npx -y awx-axi` with no arguments for a dashboard of current controller status.
2. Check authentication status with `npx -y awx-axi auth status` or log in using `npx -y awx-axi auth login`.
3. Find and launch job templates or workflow templates using `template list`, `template show <id|name>`, `template launch <id|name>`, `workflow list`, `workflow show <id|name>`, and `workflow launch <id|name>`.
4. Monitor jobs and stream stdout using `job list`, `job show <id>`, `job watch <id>`, `job stdout <id>`, and `job events <id>`.
5. Manage pending workflow approvals using `approval list`, `approval show <id|name>`, `approval approve <id|name>`, and `approval deny <id|name>`.
6. Inspect project status and sync history using `project list`, `project show <id|name>`, and `project updates <id|name>`.
7. Every response ends with contextual next-step hints under `help:` - follow them.

## Commands

```
commands[6 domains]:
  auth       login, status, logout
  job        list, show <id>, stdout <id>, events <id>, hosts <id>, relaunch <id>, cancel <id>, watch <id>
  template   list, show <id|name>, survey <id|name>, launch <id|name>
  workflow   list, show <id|name>, survey <id|name>, launch <id|name>, nodes <run-id>
  approval   list, show <id|name>, approve <id|name>, deny <id|name>
  project    list, show <id|name>, playbooks <id|name>, updates <id|name>, sync <id|name>
  setup      hooks

built-in:
  update: Upgrade awx-axi to the latest published npm version
  "update --check": Report current vs latest without installing
```

Run `npx -y awx-axi --help` for top-level usage, or `npx -y awx-axi <command> --help` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient.
- Environment variables `CONTROLLER_HOST`, `CONTROLLER_OAUTH_TOKEN`, `CONTROLLER_USERNAME`, and `CONTROLLER_PASSWORD` configure connection and authentication settings.
- Template and workflow launches support extra variables via `--extra-vars` and custom inventory or limit options.
- The `job watch` command streams job execution until completion and exits 0 on success or 1 on job failure.
- Approval subcommands accept either numeric IDs or unique workflow node names.
- All mutations report what changed and are safe to retry.
