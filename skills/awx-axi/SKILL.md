---
name: awx-axi
description: "Inspect and run AWX automation from the shell - jobs, job templates, workflows, ad hoc runs, approvals, inventories, schedules, system jobs, execution environments, projects, and identity resources. Use whenever a task involves AWX or Ansible Tower automation: checking running jobs, launching templates, approving workflow nodes, and inspecting system job templates and runs."
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

Use awx-axi whenever a task touches AWX or Ansible Tower automation: listing or inspecting running jobs; launching job templates or workflow templates; monitoring job execution and streaming stdout logs; approving or denying pending workflow approval nodes; inspecting project sync status; listing and inspecting schedules; matching templates to execution environments; inspecting historical ad hoc commands, output, and events; and reviewing system job runs and templates.
Use awx-axi for inventory workflows by starting with inventory listings, then drilling into groups, hosts, sources, and update history.

## Workflow

1. Run `npx -y awx-axi` with no arguments for a dashboard of current controller status.
2. Check authentication status with `npx -y awx-axi auth status` or log in using `npx -y awx-axi auth login`.
3. Find and launch job templates or workflow templates using `template list`, `template show <id|name>`, `template launch <id|name>`, `workflow list`, `workflow show <id|name>`, and `workflow launch <id|name>`.
4. Monitor jobs and stream stdout using `job list`, `job show <id>`, `job watch <id>`, `job stdout <id>`, and `job events <id>`.
5. Manage pending workflow approvals using `approval list`, `approval show <id|name>`, `approval approve <id|name>`, and `approval deny <id|name>`.
6. Inspect project status and sync history using `project list`, `project show <id|name>`, and `project updates <id|name>`.
7. Inspect inventories using `inventory list`, `inventory show <id|name>`, and `inventory updates <id|name>`. Use `--facts` with `inventory hosts` only when you need a fact key count.
8. Resolve schedule and template timing using `schedule list` and `schedule show <id|name>`.
9. Inspect identity resources and RBAC context with `organization list`, `organization show <id|name>`, `credential list`, `credential show <id|name>`, `user list`, `user show <id|name>`, `team list`, `team show <id|name>`, `team users <id|name>`, `team roles <id|name>`, `role list`, `role show <id|name>`, `role parents <id|name>`, and `role teams <id|name>`.
10. Inspect ad hoc execution history using `ad-hoc list`, `ad-hoc show <id>`, `ad-hoc events <id>`, and `ad-hoc stdout <id>`.
11. Inspect project access metadata using `project roles <id|name>` and then trace behavior through run-level views.
12. Match templates to container runtimes with `execution-environment list` and `execution-environment show <id|name>`.
13. Inspect recurring automation and maintenance with `system-job-template list` and `system-job-template show <id|name>`.
14. Inspect system job activity and notifications with `system-job list`, `system-job show <id>`, `system-job events <id>`, and `system-job notifications <id>`.
15. Every response ends with contextual next-step hints under `help:` - follow them.

## Commands

```
commands[21 total]:
  auth                   login, status, logout
  job                    list, show <id>, stdout <id>, events <id>, hosts <id>, relaunch <id>, cancel <id>, watch <id>
  template               list, show <id|name>, survey <id|name>, launch <id|name>
  workflow               list, show <id|name>, survey <id|name>, launch <id|name>, nodes <run-id>
  approval               list, show <id|name>, approve <id|name>, deny <id|name>
  project                list, show <id|name>, playbooks <id|name>, updates <id|name>, roles <id|name>, sync <id|name>
  ad-hoc                 list, show <id>, events <id>, stdout <id>
  inventory              list, show <id|name>, groups <id|name>, hosts <id|name>, sources <id|name>, updates <id|name>, constructed-list, constructed-show
  schedule               list, show <id|name>
  execution-environment  list, show <id|name>
  organization           list, show <id|name>
  credential             list, show <id|name>
  user                   list, show <id|name>
  team                   list, show <id|name>, users <id|name>, projects <id|name>, credentials <id|name>, roles <id|name>, object-roles <id|name>, access-list <id|name>
  role                   list, show <id|name>, parents <id|name>, children <id|name>, users <id|name>, teams <id|name>
  system-job-template    list, show <id|name>
  system-job             list, show <id>, events <id>, notifications <id>
  notification           list, show <id>
  notification-template  list, show <id|name>
  activity-stream        list, show <id>
  setup                  hooks

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
- Inventory source inspection starts with `inventory sources <id|name>` and then `inventory updates <id|name>` to review sync runs and outcomes.
- Group and host inspection starts with `inventory groups <id|name>` and `inventory hosts <id|name>`, with `--facts` adding ansible fact key counts per host.
- Approval subcommands accept either numeric IDs or unique workflow node names.
- All mutations report what changed and are safe to retry.
