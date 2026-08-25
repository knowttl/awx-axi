# Read-coverage audit

This audit starts the read-coverage initiative for AWX 24.6.1.

Evidence was checked against the registered domains in `src/cli.ts`, every domain declaration under `src/domains/`, the read/write request plans, `docs/design.md`, the full-write change in commit `499b2aa`, the smart-inventory change in commit `1589518`, and AWX source at tag `24.6.1`.

The AWX source checks used `awx/api/urls/*.py`, `awx/api/views/__init__.py`, `awx/api/serializers.py`, `awx/main/models/inventory.py`, and the tagged REST API filtering, searching, and sorting documentation.

## Confirmed existing coverage

The existing job inspection surface is complete for its v1 contract: `job list`, `job show`, `job stdout`, `job events`, `job hosts`, `job watch`, and the read paths used by cancel and relaunch are implemented in `src/domains/job/index.ts`.

The existing inventory inspection surface is complete for its v1 contract: `inventory list`, `inventory show`, `inventory groups`, `inventory hosts`, `inventory sources`, `inventory updates`, `inventory constructed-list`, and `inventory constructed-show` are implemented in `src/domains/inventory/index.ts`.

The inventory host surface already supports `--search`, `--limit`, and optional fact key counts, but it is nested under a known inventory and is not a replacement for global host lookup.

Every registered domain has an existing list and show pair unless the noun is an intentionally generated history surface with the same read-only pair.

The audit baseline had 19 registered domains: `job`, `template`, `workflow`, `organization`, `system-job-template`, `system-job`, `credential`, `approval`, `ad-hoc`, `project`, `inventory`, `schedule`, `execution-environment`, `user`, `notification`, `notification-template`, `activity-stream`, `team`, and `role`.
The first read slice added `host`, bringing the shipped total to 20 AWX domains.
This slice adds `group` and `inventory-source`, bringing the shipped total to 22 AWX domains.

## Prioritized verified gaps

### P0: top-level host inspection

`inventory host-create`, `inventory host-edit`, `inventory host-delete`, and bulk host operations exist, while `src/cli.ts` had no `host` domain and only `inventory hosts <inventory>` could list hosts.

AWX 24.6.1 defines `GET /api/v2/hosts/` and `GET /api/v2/hosts/<id>/` in `awx/api/urls/host.py`.

Host names are unique only per inventory in `awx/main/models/inventory.py`, so a bare name must be resolved across all visible inventories and cannot silently select one organization.

The first PR implements this gap as the read-only `host list` and `host show` noun.

### P1: writable inventory children need first-class reads

`inventory group-create`, `inventory group-edit`, and `inventory group-delete` have only the nested `inventory groups` list for inspection, although AWX exposes `groups/<id>/` detail and group relationship routes in `awx/api/urls/group.py`.

`inventory source-create`, `inventory source-edit`, and `inventory source-delete` have only the nested `inventory sources` list for inspection, although AWX exposes `inventory_sources/<id>/` detail and related routes in `awx/api/urls/inventory_source.py`.

Implemented in the second read slice as top-level read-only `group list/show` and `inventory-source list/show`.
The commands use the global list endpoints for deterministic id-or-name resolution, direct group hosts and children, parsed group variables, source configuration with recursive redaction, and direct inventory-source update history.

### P1: workflow topology parity

`workflow node-create`, `workflow node-edit`, `workflow node-delete`, and edge operations mutate workflow template nodes, while `workflow nodes` reads nodes for a workflow job run rather than the editable template graph.

AWX exposes `workflow_job_templates/<id>/workflow_nodes/` in `awx/api/urls/workflow_job_template.py`.

A later PR should add template-node inspection without changing the existing workflow-run node command.

### P2: parent and relationship reads

AWX 24.6.1 exposes host `all_groups`, `activity_stream`, `inventory_sources`, `smart_inventories`, `job_events`, `job_host_summaries`, `ad_hoc_commands`, and `ad_hoc_command_events` in `awx/api/urls/host.py`.

This first PR reads direct groups, parsed `variable_data`, and `ansible_facts`; the remaining host relationships should follow after the basic noun is reviewed.

AWX exposes group `children`, `hosts`, `all_hosts`, `variable_data`, job events, job host summaries, activity stream, inventory sources, potential children, and ad hoc commands in `awx/api/urls/group.py`.
This slice reads only the verified direct `children` and `hosts` relations plus `variable_data`.
The remaining group relationships stay on the P2 roadmap.

AWX exposes inventory `root_groups`, `variable_data`, `tree`, `script`, activity stream, input inventories, job templates, ad hoc commands, access list, object roles, instance groups, and labels in `awx/api/urls/inventory.py`.

AWX exposes inventory-source updates, activity stream, schedules, credentials, groups, hosts, and notification-template relationships in `awx/api/urls/inventory_source.py`.
This slice reads only direct `inventory_updates` history; schedules, access/configuration relationships, groups, hosts, notifications, and activity remain P2.

The current domain code reads only the relationships named in its public help and plans, so these remaining routes are genuine endpoint gaps rather than undocumented aliases.

### P2: role and access inspection

`template object-roles`, `workflow object-roles`, `project roles`, `credential object-roles`, and the team and role relationship commands provide partial RBAC inspection.

AWX also exposes access-list and object-role routes on several writable parent resources, including job templates, workflow templates, inventories, and teams.

Organization access/object roles and the missing inventory access/object-role reads should be grouped with a later RBAC inspection PR rather than added to the host slice.

### P2: activity and configuration inspection

The global `activity-stream list/show` noun exists, but parent-scoped activity routes for hosts, groups, inventories, inventory sources, templates, workflows, projects, organizations, teams, and users are not exposed as commands.

AWX 24.6.1 also has genuine system/configuration reads for API root, ping, settings, config, and current-user information, while the current CLI home view intentionally avoids the deprecated dashboard endpoint.

A later system-information and audit PR should add only operator-relevant read commands and preserve the existing read-only boundary.

### P2: practical filters and output fields

AWX's tagged filtering documentation supports exact and case-insensitive lookups, relation traversal, boolean combinations, `in`, null checks, `order_by`, and the designated `search` field.

The current list declarations mostly expose only `search`, a narrow resource-specific filter, `limit`, and a fixed projection, so useful filters such as enabled state, related inventory or organization, source status, ownership, and time ranges remain uneven across domains.

The current fixed projections also omit operator-relevant relationship context on several list commands, even though AWX serializers provide summary fields for those relationships.

Filters and projections should be added in resource-sized PRs after endpoint semantics and output redaction are verified, not as a broad change to the core registry.

## Writable-object read parity

| Writable object or operation | Existing read parity | Verified follow-up |
| --- | --- | --- |
| Job and workflow execution actions | `job list/show`, stdout, events, hosts, and watch | No rebuild of the explicit job coverage above. |
| Job templates | `template list/show/survey` | Add job, schedule, notification, label, instance-group, access, and activity reads. |
| Workflow templates and template nodes | `workflow list/show/survey` and workflow-run `nodes` | Add template-node list/show and parent relationships. |
| Projects and SCM updates | `project list/show/playbooks/updates/roles` plus unified job reads | Add project access, activity, notification, and related configuration reads. |
| Inventories | `inventory list/show` plus nested topology and source reads | Add parent relationships and access/object-role reads. |
| Hosts | Nested `inventory hosts` list only before this PR | The first PR adds top-level `host list/show` with cross-inventory resolution and detail reads. |
| Groups | Nested `inventory groups` list plus top-level `group list/show` with direct hosts, children, and variables | Add remaining group relationship reads only if operators need them. |
| Inventory sources | Nested `inventory sources` list and source update history plus top-level `inventory-source list/show` | Add remaining source relationships only if operators need them. |
| Schedules | `schedule list/show` | Add schedule runs and relationship reads. |
| Organizations | `organization list/show` | Add access, object roles, members, teams, and related configuration reads. |
| Execution environments | `execution-environment list/show` | Add linked templates and organization relationships if operators need them. |
| Credentials | `credential list/show/object-roles` | Add credential types, access, and usage reads with secret-safe output. |
| Users | `user list/show` | Add teams, organizations, tokens metadata, and access reads without token values. |
| Teams and team-created credentials | `team list/show/users/projects/credentials/roles/object-roles/access-list` | Add remaining team relationship filters only where AWX exposes them. |
| Notification templates | `notification-template list/show` | Add usage and activity reads. |
| Roles and grants | `role list/show/parents/children/users/teams` | Add fine-grained object-role and access inspection. |
| Generated notifications and activity records | `notification list/show` and `activity-stream list/show` | Preserve read-only status; add scoped reads only. |

## Small-PR sequence

1. `host` inspection: cross-inventory list and unambiguous show with groups, variables, facts, redaction, help, and read-only tests. Implemented.
2. `group` and `inventory-source` inspection: list/show plus direct hosts, children, updates, and variable data where the endpoint contract is verified. Implemented in this slice.
3. Workflow-template node reads and high-value parent relationships for templates, projects, inventories, and sources. This is the next separate P1b slice; keep it out of this PR.
4. RBAC access-list, object-role, membership, and role-scope inspection.
5. Host/group/inventory/source activity and operator-facing system/configuration reads.
6. Resource-sized filter and projection improvements, each backed by AWX 24.6.1 source and behavior tests.

This document intentionally keeps workflow-template node reads and the optional P2 relationships out of this slice.
