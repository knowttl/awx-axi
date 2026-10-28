# Investigation guide

Start with the relevant read below, without running `--help` first.
Assume an existing authorized profile and token; select a profile with `--profile <name>` or config with `--config <path>`.
Set `AWX_AXI_READ_ONLY=1` in the investigation environment.
Examples use synthetic fixture names and IDs; replace them with case inputs.
Commands assume a global install; otherwise replace `awx-axi` with `npx -y awx-axi`.

## Read commands and examples

Each line is an independent example, not a sequence to execute for every case.
The command prefixes in this table form a controller-read allowlist.

| Command syntax and useful flags | Result |
| --- | --- |
| `host list [--search <text>] [--name <exact-name>] [--inventory <id>] [--limit <n>]` | Hosts across visible inventories, with inventory context |
| `host show <id\|name>` | Host, groups, variables and facts in one invocation |
| `group show <id\|name>` | Direct hosts, child groups and parsed variables |
| `inventory hosts <id\|name> [--search <text>] [--facts] [--limit <n>]` | Inventory hosts; optional fact key counts per returned host |
| `job list [--type <type>] [--status <status>] [--failed] [--since <time>] [--limit <n>] [--fields <fields>]` | Newest runs; defaults to playbook jobs and 20 rows |
| `job show <id> [--type <type>]` | Run detail, host rollup and failed tasks; workflow node rollup for workflow runs |
| `job stdout <id> [--type <type>] [--tail <n> \| --lines <a-b>]` | Log slice |
| `job events <id> [--failed] [--host <name>] [--task <text>] [--limit <n>]` | Playbook task events |
| `job hosts <id> [--limit <n>]` | Playbook host outcomes |
| `job watch <id> [--type <type>] [--timeout <seconds>] [--interval <seconds>]` | Bounded read-only wait for an existing run |
| `workflow nodes <run-id> [--limit <n>]` | Workflow run nodes, distinct from editable template nodes |
| `activity-stream list [--operation <operation>] [--search <text>] [--job <id>] [--limit <n>]` | Audit events; use at most one resource scope |
| `activity-stream show <id>` | Audit event changes |

```sh
awx-axi host list --search web --inventory 11 --limit 5
awx-axi host show web-01.example.com
awx-axi group show 31
awx-axi inventory hosts 11 --facts --limit 5
awx-axi job list --type all --failed --since 2h --limit 5 --fields type,launched_by,template
awx-axi job show 1839 --type job
awx-axi job stdout 1839 --type job --tail 50
awx-axi job events 1839 --failed --limit 5
awx-axi job hosts 1839 --limit 5
awx-axi job watch 1839 --type job --timeout 60 --interval 5
awx-axi workflow nodes 1840 --limit 5
awx-axi activity-stream list --job 1839 --limit 5
awx-axi activity-stream show 9001
```

## Fewer calls, bounded output

Use `host show` directly with a known name: it resolves the ID and gathers groups, variables and facts.
Duplicate names across inventories require an ID from the ambiguity response or filtered list.
Use `inventory hosts --facts` instead of listing then showing each host when fact key counts suffice; it still makes per-host controller reads and does not return fact values.
There is no general batch `show` for full host details.
`job show --type job` includes host and failure summaries; specifying a known type avoids a type-discovery request.
`job list --type all` includes workflows, syncs, ad-hoc and system runs; `--since` filters on finish time, so it excludes unfinished runs.
Use `job watch` instead of writing a poll loop: defaults are 600 seconds and a 5-second initial interval, backing off to 30 seconds.
Authorized launch and sync commands offer `--wait --timeout <seconds>`; set an explicit timeout because defaults vary by command, and these commands change state and are outside the read allowlist.

Collection `--limit` accepts 1-1,000 rows.
Alternatively use `--all --max-rows <n>` (default and maximum 10,000 rows, at most 100 pages); do not combine `--all` with `--limit`.
Check completeness, truncation and stop reason before claiming exhaustive results.
With `partial_page: true`, following `next` skips undisplayed rows; rerun with a larger budget or narrower filters.
Detail aggregates gather complete related collections and have no row-limit flag.
`--fields` adds fields only where advertised; for job lists, `type`, `launched_by` and `template` usually avoid detail calls, while `created`, `started` and `elapsed` help with timing.
It does not remove default fields; host reads have no `--fields` flag.
Prefer stdout `--tail 50` or `--lines 1-50`; `--full` does not bypass controller truncation.

## Safety, help and failures

Only the table's reads belong in this investigation allowlist.
Create/edit/copy/delete, association changes, grants/revokes, approvals, launches, relaunches, syncs, tests and cancellations change controller state.
Domain mutations preview by default and require `--confirm`; config, delete and security writes additionally require their matching `AWX_AXI_ALLOW_*` gate.
`auth login` mints a token and `auth logout` revokes one immediately, without a preview; neither is an investigation read.
`setup`, `profile`, `config` and `update` are outside this controller-read list; some change local state.
Never pass credentials as arguments; read-only mode blocks controller mutations, including token operations.

Use help to recover after a command fails or for an unfamiliar operation.
Top-level `--help` returns usage, global selectors, domain names and built-ins; `<noun> --help` lists that domain's subcommands; `<noun> <verb> --help` gives focused syntax and documented flags, sometimes defaults/examples.
The no-argument command instead reads a live dashboard and can exit 0 even when its dashboard reports an error.

TOON data and structured `error`, `code`, `help` go to stdout; diagnostics go to stderr.
Exit 0 means success, 2 means usage/ambiguity/input error, and 1 means runtime failure or a watched run that failed, errored or was canceled.

| Code | Adjust before retrying |
| --- | --- |
| `PROFILE_REQUIRED`, `AUTH_REQUIRED` | Check profile selection and the existing credential; do not mint a token without authorization |
| `FORBIDDEN` | Check AWX account roles; local write gates grant no permissions |
| `NAME_NOT_FOUND`, `NOT_FOUND` | Check name, ID, profile and visibility; narrow the host list |
| `AMBIGUOUS_NAME` | Use a returned numeric ID; do not choose a duplicate arbitrarily |
| `VALIDATION_ERROR` | Correct arguments using the error hint or focused help |
| `READ_ONLY_VIOLATION` | Stop the mutation and use reads |
| `OUTPUT_TOO_LARGE` | Use failed events |
| `INCOMPLETE_COLLECTION` | Treat aggregate evidence as incomplete; check controller pagination |
| `WATCH_TIMEOUT` | The existing run continues; resume watching its ID if needed, never relaunch to retry a read |
| `CONTROLLER_UNREACHABLE`, `TLS_UNTRUSTED` | Check connectivity, selected origin and certificate trust |
| `SERVER_BUSY`, `SERVER_ERROR` | Controller failure; defer and retry within the case's retry budget |
