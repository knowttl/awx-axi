# Safety and permissions

## Write gates

Domain mutations default to previews.
Use `--confirm` to execute; `--dry-run` forces a preview even with `--confirm`.
Previews may perform reads to resolve names and validate input.
`AWX_AXI_READ_ONLY=1` blocks every controller write, including login/logout, before a mutation reaches the wire.
All gates default to false and accept `1`, `true`, `0` or `false`, case-insensitively.

| Capability | Required live opt-in |
| --- | --- |
| Launch jobs, workflows, ad-hoc modules and system jobs; sync projects/inventories; cancel/relaunch jobs; approve/deny workflow gates; test notification templates | `--confirm`; credential passwords have an additional gate below |
| Create/edit ordinary configuration; copy templates/workflows; manage labels, instance groups and notification associations | `--confirm` and `AWX_AXI_ALLOW_CONFIG_WRITES=1` |
| Delete configuration resources, users, teams or credentials | `--confirm` and `AWX_AXI_ALLOW_DELETES=1` |
| Create/edit/copy credentials; create/edit users and teams; manage memberships, role assignments, credential associations and user tokens | `--confirm` and `AWX_AXI_ALLOW_SECURITY_WRITES=1` |
| Copy projects, execution environments or notification templates | `--confirm` and `AWX_AXI_ALLOW_SECURITY_WRITES=1` |
| Create/edit execution environments or inventory sources with a `credential` field in the payload | `--confirm` and `AWX_AXI_ALLOW_SECURITY_WRITES=1`; without that field, the config gate applies |
| Create/edit notification templates with secret input | `--confirm` and `AWX_AXI_ALLOW_SECURITY_WRITES=1`; without secret input, the config gate applies |
| Inventory source credential add/remove | `--confirm` and `AWX_AXI_ALLOW_SECURITY_WRITES=1` |
| Template launch or job relaunch supplying credential passwords | `--confirm`, `AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS=1` and `--credential-passwords-file <path>` |
| `auth login` | Immediate token creation; username/password environment credentials; no preview or confirmation switch |
| `auth logout` | Immediate upstream token revocation and local removal; both `AWX_AXI_ALLOW_DELETES=1` and `AWX_AXI_ALLOW_SECURITY_WRITES=1`; no preview or confirmation switch |

The configuration, deletion and security gates select write families rather than forming a cumulative hierarchy.
Logout explicitly checks both gates.
Consult [command help](commands.md) for each operation's inputs and preview.
There is no separate CLI resource allowlist; use controller RBAC to restrict targets.

Ad-hoc launch runs the supplied module against the target inventory.
Approving a workflow gate can release downstream automation.
Read the preview before confirming either action.

## Permissions

| API permission | Needed for |
| --- | --- |
| PAT with read scope and AWX RBAC visibility | Read commands and dashboard |
| PAT with write scope plus the corresponding resource roles | Launch, approval, management and other confirmed writes |
| Username/password with token-creation permission | `auth login`, which requests scope `write` |

Environment gates do not grant controller permissions.
The controller still enforces RBAC.
Use the least privilege needed for the requested commands.

## Credentials and data flow

Credentials stay in environment references, private files or protected local state.
See [authentication and credentials](credentials.md) for storage and platform permissions.
Secrets are redacted from structured output; resource data and logs can still contain sensitive operational content.
Controller requests send authentication plus requested query parameters or mutation payloads to the selected origin.
Discovery makes unauthenticated metadata reads.
Installation, skill installation and update commands contact their package or source services.
Controller mutation responses record method, timestamp and status in the local write journal.
The journal contains no request payload or credential.
