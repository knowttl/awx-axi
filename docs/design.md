# awx-axi v1 design

Status: design only.
No command implementation ships with this document.
Implementation lands as separate follow-up tasks against this design.

Target controller: **Ansible AWX 24.6.1**.
Every API behavior asserted here was read from `github.com/ansible/awx` at tag `24.6.1` and is cited to a file
and line in §16.
Where a behavior is version-sensitive, §4 says so explicitly.

## 1. Purpose and scope

`awx-axi` is an agent-facing CLI for operating an AWX controller from the shell, built to the AXI standard
(the user-level `axi` skill).

v1 buys depth in the three domains an operator actually touches during an incident or a release, and declines
breadth across AWX's configuration surface.

**v1 core:**

1. **Jobs.**
   The unified run surface: list, inspect, read output, read events, host rollups, cancel, relaunch, and watch
   to completion.
   This covers playbook jobs, workflow jobs, project updates, inventory updates, ad hoc commands, and system
   jobs through one set of verbs, because AWX models all of them as unified jobs.
2. **Workflows.**
   Workflow job templates, launching them, per-node rollups for a running or finished workflow, and the
   approval inbox: list, show, approve, deny.
3. **Projects.**
   List, inspect, trigger an SCM sync, list playbooks, and list recent syncs.

**Supporting reads (enablers, not a product surface of their own):**

Job templates exist in v1 only because a job cannot be launched without one.
`template list`, `template show`, `template launch`, and `template survey` are the launch enabler, not a job
template management surface.
There is no template create, update, delete, or copy in v1.

## 2. Non-goals for v1

- **No configuration management surface.**
  Inventories, hosts, groups, inventory sources, organizations, teams, users, credentials, credential types,
  schedules, execution environments, notification templates, labels, instances, and instance groups are all
  out.
  They are recorded as roadmap in §14.
- **No deletes, anywhere, at all.**
  Not behind a flag, not behind an environment variable.
  This is a structural property of the design: no domain module in v1 declares a `DELETE` route, so there is no
  code path that can issue one.
- **No credential or user writes.**
  awx-mcp gates these four tools behind `AWX_MCP_ENABLE_CREDENTIAL_MANAGEMENT`.
  awx-axi v1 goes further and omits them, so the gate has nothing to protect (§6).
- **No RBAC surface.**
  Role grants and revocations are the highest-blast-radius writes in AWX and are out of v1.
- **No ad hoc command execution.**
  `run_ad_hoc_command` runs arbitrary modules against arbitrary hosts with no template review.
  Reading an existing ad hoc command's result is in scope through the unified `job` noun; creating one is not.
- **No bulk endpoints.**
  `/api/v2/bulk/job_launch` wraps its jobs in a workflow job that a non-admin cannot see in the UI job list,
  which is a confusing enough side effect that it needs its own design pass.
- **No websocket streaming.**
  `job watch` polls (§7.9). AWX's event websocket is a separate transport with its own auth handshake.

## 3. Backend choice: the AWX REST API v2

### 3.1 Decision

**awx-axi speaks the AWX REST API v2 directly over HTTPS from Node.
It does not shell out to the `awx` CLI (awxkit).**

The commission permits either.
This section is the justification, and §3.4 is the honest statement of what that choice costs.

### 3.2 Why the REST API rather than wrapping awxkit

**HTTP status codes are load-bearing semantics in AWX, and a CLI wrapper throws them away.**

This is the decisive reason, not a stylistic preference.
AWX signals several distinct outcomes purely through the status code:

- Cancel on a job that already finished returns **405 Method Not Allowed**, via `http_method_not_allowed`.
  Not 400, not 409.
- Project sync on a project with no SCM source returns the **same 405**.
- Cancel that succeeds returns **202** with an empty body.
- Approve and deny that succeed return **204** with an empty body.
- Launch that succeeds returns **201**; launch that needs credential passwords returns **400** and deletes the
  half-created job.

AXI §6 requires that an already-satisfied intent be a no-op with exit 0 and that everything else carry an
actionable translated error.
Distinguishing "already finished, nothing to do" from "this project can never be synced" requires seeing the
405 and then reading the object's state.
Wrapping a CLI reduces all of that to text on stderr and a process exit code.

Four supporting reasons:

- **Runtime dependency.**
  awxkit is a Python package installed with `pip`, version-coupled to the controller.
  The development machine for v1 has neither `awx` nor Python's awxkit installed.
  awx-axi ships as a Node CLI alongside `gh-axi`, `tasks-axi`, and `quota-axi`, with no second language
  runtime.
- **Interactive behavior.**
  `awx login` writes a config file and awxkit is built around a human at a terminal.
  AXI §6 forbids interactive prompts outright.
  Suppressing prompts from a wrapped tool is strictly more work than not having them.
- **Error translation.**
  AXI §6 forbids leaking dependency output and forbids naming the underlying tool.
  A wrapper's raw material is prose on stderr; the API's raw material is a status code plus a typed JSON body
  (`{"field": ["message"]}` for field errors, `__all__` for non-field errors, `detail` for permission errors).
  The second translates cleanly into a stable error code table (§9.1); the first is pattern-matching on
  English.
- **Partial output.**
  The stdout endpoint accepts `start_line` and `end_line` and returns `absolute_end`, the total line count.
  That is exactly the truncation contract AXI §3 asks for: a preview plus how much is missing.
  awxkit's stdout commands print the whole body and nothing else.

### 3.3 What "not reimplementing" means here

The commission's hard requirement is not to reimplement auth, pagination, or job polling from scratch.
awx-axi consumes AWX's own mechanisms rather than inventing parallel ones:

- **Auth** is AWX's OAuth2 personal access token, minted by AWX at `POST /api/v2/tokens/` and presented as a
  bearer token.
  awx-axi does not implement a credential store, a token format, or a refresh protocol.
- **Pagination** is AWX's `{count, next, previous, results}` envelope.
  awx-axi follows the server-provided `next` URL and reports the server-provided `count`.
  It does not compute offsets or guess at totals.
- **Polling** reads AWX's own `status` field against AWX's own documented status set, including AWX's
  `CAN_CANCEL` definition of which states are still active.
  awx-axi does not model job lifecycle independently.

### 3.4 What this choice costs, stated plainly

awx-axi owns an HTTP client, a retry policy, a pagination walk, and a poll loop.
Those are real code that a wrapper would not have written.
The mitigation is that all four live behind one interface (`AwxTransport`, §10.3), are written once, and are
the most heavily tested part of the offline suite (§11.2).

awx-axi also takes on version coupling to the API surface rather than to a CLI.
§4 is the answer to that.

### 3.5 Configuration compatibility with the official CLI

awx-axi reads the **same environment variables awxkit uses**, so an operator who already configured the
official CLI needs no new setup:

| Variable | Meaning |
| --- | --- |
| `CONTROLLER_HOST` | Controller base URL, e.g. `https://awx.example.com` |
| `CONTROLLER_OAUTH_TOKEN` | Bearer token, preferred credential |
| `CONTROLLER_USERNAME` | Basic-auth username, used by `auth login` and the read-only live suite (§5.1) |
| `CONTROLLER_PASSWORD` | Basic-auth password, used by `auth login` and the read-only live suite (§5.1) |
| `CONTROLLER_VERIFY_SSL` | `false` disables TLS verification |

`AWX_AXI_*` variables cover what awxkit has no equivalent for: `AWX_AXI_HOME` for the token file location,
`AWX_AXI_LIVE` and `AWX_AXI_RECORD` for tests, `AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS` for the §6.3 gate, and
`AWX_AXI_READ_ONLY` for the §6.5 boundary.
The one exception is `AWX_AXI_API_BASE_PATH` for the §4.2 gateway case, which deliberately mirrors awxkit's own
`AWXKIT_API_BASE_PATH` under our prefix rather than reading a variable named for another tool.

## 4. Target version and version-sensitive surface

### 4.1 Verified against 24.6.1

The captain runs AWX 24.6.1.
Every fact in this document was read from that tag.
The values that the design hard-codes or asserts:

| Fact | Value at 24.6.1 |
| --- | --- |
| API root | `/api/v2/` |
| Default page size | 25 |
| `MAX_PAGE_SIZE` | 200 |
| Job statuses | `new`, `pending`, `waiting`, `running`, `successful`, `failed`, `error`, `canceled` |
| Active states | `new`, `pending`, `waiting`, `running` |
| Displayable stdout cap | 1048576 bytes |
| Per-event stdout cap | 1024 bytes |
| Token endpoint | `POST /api/v2/tokens/` |

Note the American single-`l` `canceled` on the status value, alongside the `canceled_on` timestamp field.
awx-axi never emits `cancelled`.

### 4.2 The surfaces that move between versions

- **Auth and base path.**
  24.6.1 authenticates directly against the controller and mints tokens at `/api/v2/tokens/`.
  AAP 2.5 and later front the controller with a platform gateway, move the controller API under
  `/api/controller/v2/`, and move token issuance to the gateway; this is why awxkit grew
  `AWXKIT_API_BASE_PATH`.
  awx-axi handles this by **probing `GET /api/`** for the advertised version list on first use and caching the
  resolved base path, with `AWX_AXI_API_BASE_PATH` as an explicit override.
  That same first-use probe also reads **`GET /api/v2/ping/`** for the controller *release*, because
  `GET /api/` advertises the API version list and never the release, and the home header in §8.1 names the
  release.
  Both values are cached together, so the release costs one request on first use and nothing afterwards; at
  24.6.1 `ping` requires no authentication, so the probe also works before credentials are resolved.
  Only 24.6.1 is verified and tested; a gateway-fronted controller is best-effort until someone runs the live
  suite against one.
- **`MAX_PAGE_SIZE` is operator-tunable.**
  It is a Django setting an administrator can raise in `/etc/awx/conf.d/`.
  awx-axi never assumes 200 is the ceiling; it requests the page size it wants and trusts the envelope, because
  AWX silently caps an oversized `page_size` rather than rejecting it (§4.3).
- **`/api/v2/dashboard/` is deprecated at 24.6.1.**
  The view carries `deprecated = True`.
  awx-mcp's `get_dashboard_stats` targets it.
  awx-axi computes its aggregates from filtered list counts instead (§8.1), so nothing in v1 depends on a
  deprecated endpoint.
- **Named URL formats are controller-specific and grow over time.**
  `NAMED_URL_FORMATS` is read-only and advertised at `/api/v2/settings/named-url/`.
  awx-axi resolves names by filtered query rather than by constructing named URLs (§7.3), which sidesteps the
  format entirely.

### 4.3 API behaviors the design must route around

These are not bugs to report; they are properties the client must handle.
Each is a named offline test in §11.2.

1. **An oversized `page_size` is silently capped, not rejected.**
   `Pagination.cap_page_size` rewrites the value in the `next` and `previous` links.
   A client that asks for 1000 and assumes it got 1000 will silently under-read.
   awx-axi therefore always paginates from the envelope's `next` link and never infers page boundaries.
2. **`?count_disabled` destroys the total count.**
   Its paginator hardcodes `count` to 200 and `num_pages` to 1, and the response omits `count`, `next`, and
   `previous` entirely.
   awx-axi **never sends it**, because the free total count is the whole basis of the `count: N of M total`
   line AXI §4 requires.
3. **On event endpoints, `limit` and `count` are mutually exclusive.**
   Passing `?limit=N` to a job-event list switches AWX to `LimitPagination`, which returns bare
   `{"results": [...]}` with no count at all.
   `job events` therefore uses `page_size`, not `limit`, so the total stays available.
4. **Oversized stdout returns HTTP 200 with an apology sentence as the body.**
   Above the 1 MiB display cap the endpoint returns 200 whose content is the English text
   "Standard Output too large to display (N bytes), only download supported for sizes over M bytes."
   For `format=json` that sentence arrives in `content` with `range` `{start: 0, end: 1, absolute_end: 1}`.
   A client that trusts the status code prints the apology as though it were playbook output.
   awx-axi detects the shape and raises `OUTPUT_TOO_LARGE` with a pointer to `--download` (§9.1).
5. **A named-URL lookup turns 403 into 404.**
   `api_exception_handler` rewrites a 403 to `Not found.` for any request that arrived through a named URL, to
   avoid leaking resource existence.
   So a named lookup cannot distinguish "does not exist" from "you cannot see it".
   §7.3's resolution strategy avoids named URLs partly for this reason, and §9.1's `NAME_NOT_FOUND` help text
   names permission as a possible cause.
6. **Launch silently drops fields the template does not prompt for.**
   Any field submitted without the matching `ask_*_on_launch` enabled is discarded and reported in
   `ignored_fields`, and the job runs anyway with different behavior than requested.
   This is the single most dangerous behavior for an agent, and §7.5 is the response to it.
7. **There are no sparse fieldsets.**
   No `?fields=` support exists anywhere in the API.
   Every list response carries the full serializer payload regardless of what awx-axi prints.
   awx-axi's minimal schemas save agent tokens, not controller bandwidth, and the design does not claim
   otherwise.
8. **Every URI without a trailing slash gets a 301.**
   All routes in awx-axi are written with the trailing slash so no request is ever redirected.

## 5. Auth model and credential handling

### 5.1 Resolution order

1. `CONTROLLER_OAUTH_TOKEN` from the environment.
2. The token file at `$AWX_AXI_HOME/token` (default `~/.awx-axi/token`), mode `0600`, written only by
   `auth login`.
3. Nothing.
   Every command then fails with `AUTH_REQUIRED` and the exact next command to run.

Basic auth is **never** used for ordinary requests, even when `CONTROLLER_USERNAME` and `CONTROLLER_PASSWORD`
are set.
It is used by `auth login` alone, to mint a token.
This keeps the password out of the request path of every other command, and it degrades gracefully on
controllers where an administrator has disabled basic auth.

**The read-only live suite is the one exception, and it exists because of §6.5.**
Minting a token is a `POST /api/v2/tokens/`, which the live-instance boundary forbids.
So the live suite authenticates with basic auth directly for its GETs rather than calling `auth login`, and
`auth login` is itself one of the commands the live suite is forbidden to exercise.
This is a deliberate inversion of the rule above, confined to `test/live/`, and it is the reason §6.5's
enforcement lives in the transport rather than in the auth layer.

### 5.2 `auth login` is non-interactive

```
$ awx-axi auth login
auth:
  controller: awx.example.com
  user: btsai
  token: stored in ~/.awx-axi/token
  scope: write
```

It reads `CONTROLLER_USERNAME` and `CONTROLLER_PASSWORD` from the environment, POSTs to `/api/v2/tokens/`, and
writes the returned token to the token file at `0600`.
It **never prompts**, per AXI §6.
With the variables unset it exits 2 and says which ones are missing.

The token value is never echoed to stdout, not even truncated.

Two version notes surface here as help text rather than silent failure: `ALLOW_OAUTH2_FOR_EXTERNAL_USERS` is
false by default, so an SSO-provisioned user cannot mint a token and gets a 403 with an explanation pointing at
`CONTROLLER_OAUTH_TOKEN` instead; and AWX's default token lifetime is effectively unbounded, so awx-axi does
not implement refresh.

### 5.3 No secret is ever a command-line argument

This is a hard rule from the commission, and it is enforced structurally: **`core/flags.ts` rejects any flag
declaration whose name matches the secret pattern** (`token`, `password`, `secret`, `key`, `passphrase`) at
module load, so a future contributor cannot add `--token` without the CLI failing its own unit test.

Secrets reach awx-axi through the environment or through a `0600` file, never through `argv`, because `argv` is
visible in `ps` output, shell history, and agent transcripts.

`auth status` reports whether a credential resolved and who it belongs to, never the value:

```
$ awx-axi auth status
auth:
  controller: awx.example.com
  source: ~/.awx-axi/token
  user: btsai
  valid: true
```

## 6. Write surface and risk posture

Unlike a read-only tool, awx-axi v1 has writes.
This section is the framing that keeps them defensible.

### 6.1 The three tiers

**Tier 1 - reversible operational writes. In v1, ungated.**

`job cancel`, `job relaunch`, `template launch`, `workflow launch`, `project sync`, `approval approve`,
`approval deny`.

These are the actions an operator takes during an incident.
Each is reversible or repeatable in the ordinary course of operations: a canceled job can be relaunched, a
launched job can be canceled, a sync can be re-run.
They change no AWX configuration, so the controller's own state is the same shape afterwards.

Approvals deserve a note: approving a workflow step is *operationally* consequential because it releases
downstream automation, and it cannot be un-approved.
It stays in tier 1 anyway, because refusing it would make the approval inbox read-only and therefore useless,
and because AWX's own permission model already gates it to users with approval rights.
awx-axi's contribution is to make the decision informed rather than blind: `approval show` prints what the step
gates and which workflow it belongs to before anyone approves it.

**Tier 2 - configuration writes. Out of v1 entirely.**

Create, update, and copy of templates, projects, inventories, hosts, groups, schedules, execution
environments, notification templates, and labels.

**Tier 3 - destructive and security-sensitive writes. Out of v1, structurally.**

Every delete, every credential write, every user write, every role grant or revoke.
No v1 domain module declares a `DELETE` route, so there is no code path to reach one.

### 6.2 Every tier-1 write is confirmable before it happens

`--dry-run` is available on all seven tier-1 commands and prints exactly what would be sent, resolving names to
ids, without issuing the mutation:

```
$ awx-axi template launch "Deploy web tier" --limit db-02 --dry-run
dry_run:
  action: launch
  template: 12 (Deploy web tier)
  inventory: 3 (Production)
  limit: db-02
  would_send: POST /api/v2/job_templates/12/launch/
help[1]: Re-run without --dry-run to launch
```

This exists because an agent that resolved the wrong template by name should discover that before starting a
playbook, not after.

### 6.3 Credential passwords: refused by default, gated when needed

Some templates need a credential password at launch: a vault password, an SSH key unlock, a become password.
AWX reports these in `passwords_needed_to_start`.

v1 **refuses to launch such a template by default**, with `LAUNCH_INPUT_REQUIRED` and an explanation.
Supplying the value would mean carrying a secret, and §5.3 forbids the obvious channel.

The opt-in gate, mirroring awx-mcp's approach:

- `AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS=1` must be set in the environment.
- Values are read from a `0600` file named by `--credential-passwords-file <path>`, as a JSON object keyed by
  the password names AWX asked for.
- The file path is a flag; the values never are.
- awx-axi verifies the file's mode before reading it and refuses a world-readable or group-readable file.
- The values are never echoed, not in `--dry-run`, not in an error, not in a suggestion.

### 6.4 Redaction of log output

AWX applies `UriCleaner.remove_sensitive` to project-update output **only on the download renderer**, not on
the ordinary `txt`, `ansi`, or `json` stdout paths that awx-axi reads.
awx-axi therefore applies its own redaction (`core/redact.ts`) to every log body it prints, replacing
credentials embedded in SCM URLs and anything matching AWX's own `$encrypted$` marker.
Redaction is applied on the way to stdout, and the redaction pass is unit-tested against a fixture containing a
`https://user:token@github.com/...` remote.

### 6.5 The live-instance boundary: read-only, enforced in code

The captain has provided credentials for a real AWX instance at `~/.config/awx-axi/live-smoke.env` (mode `0600`,
carrying `CONTROLLER_HOST`, `CONTROLLER_USERNAME`, and `CONTROLLER_PASSWORD`).

**That account has full read and write permission, and the captain's order is that nothing on the instance may
be modified.**
This is a hard boundary on every live use by any worker, test, or benchmark, and it outranks every convenience
in this document:

- Live traffic is **read-only GETs only**.
  No job or workflow launch, relaunch, or cancel.
  No project sync.
  No approve or deny.
  No create, update, or delete of any object.
  No `POST`, `PUT`, `PATCH`, or `DELETE` of any kind.
- The one conceivable exception, minting a read-scoped token, is itself a `POST` and is therefore **also
  forbidden** unless the captain is asked first through the main firstmate.
  §5.1 records the consequence: the live suite uses basic auth for its GETs instead.
- The credential file is **sourced, never read for its values**.
  Nothing prints, copies, commits, or writes those values anywhere, including test fixtures, recorded
  responses, logs, error messages, benchmark output, and reports.
- The benchmark (§14.3) uses read-only tasks only.

**A promise in a document is not an enforcement mechanism, so this is enforced at the transport seam.**
`AWX_AXI_READ_ONLY=1` makes `AwxTransport` refuse every non-GET request before it is issued, raising a
`READ_ONLY_VIOLATION` error naming the method and route that was attempted.
The check sits in `HttpTransport` itself, below every domain module and every command, so no command,
subcommand, retry path, or future contributor can route around it.
The live harness sets the variable unconditionally rather than accepting it from the ambient environment, and
`AWX_AXI_READ_ONLY=1` is also available to operators who simply want a safe posture.

This mirrors awx-mcp's `AWX_MCP_READ_ONLY`, with one difference: awx-mcp's read-only mode changes which tools it
*exposes*, while awx-axi's blocks the request at the wire, which is the stronger guarantee and the one the
captain's boundary needs.

Two tests carry this rather than a comment: one asserting that every tier-1 write command raises
`READ_ONLY_VIOLATION` and issues no request when the flag is set, and one asserting that the live suite's own
harness sets it and that no `test/live/` case **issues** a non-GET request.
The rule is about what reaches the wire, not about which command names appear: §11.3 covers the write commands
with `--dry-run` against the live instance, and a dry run constructs a payload without issuing anything, so it
satisfies this test rather than contradicting it.

## 7. Command surface

### 7.1 Top level

```
awx-axi                              home view: what is running, what needs a decision, what broke
awx-axi job        <subcommand>       the unified run surface
awx-axi template   <subcommand>       job templates: the launch enabler
awx-axi workflow   <subcommand>       workflow job templates and node rollups
awx-axi approval   <subcommand>       the workflow approval inbox
awx-axi project    <subcommand>       projects and SCM syncs
awx-axi inventory  <subcommand>       inventories, groups, hosts, sources, updates
awx-axi auth       login|status|logout
awx-axi setup      hooks
awx-axi update                        reserved by axi-sdk-js
```

Eight nouns.
`job` carries the most weight deliberately, per §7.2.

### 7.2 `job` - one noun for everything AWX runs

AWX models playbook jobs, workflow jobs, project updates, inventory updates, ad hoc commands, and system jobs
as subclasses of one unified job, listed together at `/api/v2/unified_jobs/`.
awx-axi exposes that as one noun rather than six.

```
awx-axi job list                     [--status] [--type] [--template] [--failed] [--since] [--limit] [--fields]
awx-axi job show <id>                [--type]
awx-axi job stdout <id>              [--tail N | --lines A-B] [--full] [--download <path>] [--ansi] [--type]
awx-axi job events <id>              [--failed] [--host] [--task] [--limit] [--type]
awx-axi job hosts <id>               per-host ok/changed/failed/unreachable rollup
awx-axi job cancel <id>              [--dry-run] [--type]
awx-axi job relaunch <id>            [--failed-only] [--dry-run] [--type]
awx-axi job watch <id>               [--timeout 600] [--interval 5] [--type]
```

`--type` accepts `job` (default for `list`), `workflow`, `project-update`, `inventory-update`, `ad-hoc`,
`system`, and `all`.

**Type resolution.**
`/api/v2/unified_jobs/` has no detail endpoint, so `job show 1839` cannot GET a unified job directly; it needs
the concrete type to pick `/api/v2/jobs/1839/` versus `/api/v2/workflow_jobs/1839/`.
awx-axi resolves it with one filtered list request (`/api/v2/unified_jobs/?id=1839`), reads `type` from the
single result, and then GETs the typed endpoint.
Passing `--type` skips that request.
The cost is documented in §7.10 rather than hidden.

This collapse is what lets one command answer a question that spans kinds.
`awx-axi job list --type all --failed --since 2h` answers "what broke in the last two hours" across playbook
jobs, workflow runs, and SCM syncs in a single call, which is not expressible in awx-mcp without four separate
list tools and a client-side merge.

`--status` matches **one exact AWX status**, or `all`; an unrecognized value is a `VALIDATION_ERROR` (§9.1)
rather than a silent empty result.
`--failed` is a separate flag precisely because it is **not** a status: it maps to AWX's own `?failed=true`,
which matches the whole failed family and so covers both `failed` and `error`.
Keeping them separate is what makes `--status` predictable enough to reject unknown values.

It also means there is exactly one log command, one cancel command, and one watch command in the whole CLI.
A project sync's output is `job stdout <sync-id>`, not a separate `project logs`.

### 7.3 Resolving objects by name

Every command that takes an object accepts a numeric id or a name.

Names resolve by **filtered query**, not by named URL: `?name=<value>` for an exact match, falling back to
`?name__iexact=<value>`.
Two reasons, both from §4.3: a named-URL 403 is indistinguishable from a 404, and named URL formats vary by
controller and grow between releases.
A filtered query returns a count, which lets awx-axi tell the three cases apart honestly:

- exactly one match: proceed.
- zero matches: `NAME_NOT_FOUND`, exit 1, with a help line suggesting the matching `list --search` command and
  noting that a name invisible to this user looks identical to a name that does not exist.
- more than one match: `AMBIGUOUS_NAME`, exit 2, printing the candidates with their ids and organizations so
  the correction takes one turn.

```
$ awx-axi template launch "Deploy web tier"
error: 2 job templates are named "Deploy web tier"
code: AMBIGUOUS_NAME
candidates[2]{id,name,organization}:
  12,Deploy web tier,Production
  41,Deploy web tier,Staging
help[1]: Re-run with the id, e.g. `awx-axi template launch 12`
```

AWX's own compatibility behavior here is worth not copying: a legacy bare-name named URL for a job template
returns the **oldest** match on a collision.
awx-axi refuses instead, because silently picking one of two production templates is exactly the failure AXI §6
exists to prevent.

### 7.4 `template` - the launch enabler

```
awx-axi template list                [--project] [--search] [--limit] [--fields]
awx-axi template show <id|name>
awx-axi template survey <id|name>
awx-axi template launch <id|name>    [--limit] [--tags] [--skip-tags] [--extra-vars] [--inventory]
                                     [--scm-branch] [--verbosity] [--job-type] [--diff]
                                     [--wait] [--timeout] [--dry-run]
```

`template show` reports what the template will and will not accept at launch, because that is the question
asked immediately before launching:

```
$ awx-axi template show 12
template:
  id: 12
  name: Deploy web tier
  project: 4 (infra-playbooks)
  playbook: deploy/web.yml
  inventory: 3 (Production)
  last_run: 1841 running
  prompts_on_launch[3]: limit,job_tags,extra_vars
  survey: enabled, 2 required questions
  needs_at_launch: none
help[2]: Run `awx-axi template survey 12` for the survey questions,Run `awx-axi template launch 12 --limit <hosts>` to launch
```

`prompts_on_launch` is the derived list of fields whose `ask_*_on_launch` is true.
It is the field that makes §7.5 possible, and it is in the default schema rather than behind `--fields`
precisely because launching without it is how an agent gets silently wrong behavior.

### 7.5 Launch preflight: the answer to silently ignored fields

AWX's launch endpoint discards any submitted field the template does not prompt for, reports it in
`ignored_fields`, and runs the job anyway.
An agent that passes `--limit db-02` to a template with `ask_limit_on_launch` disabled gets a **successful
launch against every host in the inventory**.

AXI §6 requires failing loud on input that will not take effect.
So every launch does a **preflight `GET .../launch/`** first, which reports `can_start_without_user_input`,
`passwords_needed_to_start`, `variables_needed_to_start`, and the `ask_*` flags.
awx-axi compares the caller's flags against that and **refuses before any side effect**:

```
$ awx-axi template launch 18 --limit db-02
error: template 18 does not accept --limit at launch; the job would run against the whole inventory
code: LAUNCH_WOULD_IGNORE_INPUT
ignored[1]{flag,reason}:
  --limit,ask_limit_on_launch is disabled on this template
help[2]: Run `awx-axi template launch 18` to launch with the template's own limit,Run `awx-axi template show 18` to see which flags this template accepts
```

Exit 2, since this is a usage error against this particular template.
The preflight is not optional and there is no flag to skip it: one cheap GET is worth strictly less than one
wrong playbook run, and an agent given the choice will skip it.

The preflight also catches the two cases that would otherwise cost a wasted round trip: a required survey
variable that was not supplied becomes `LAUNCH_INPUT_REQUIRED` before the POST, and a template needing a
credential password hits the §6.3 refusal before the POST.

**The race still gets handled.**
If someone toggles an `ask_*` flag between the preflight and the POST, the response can still carry a non-empty
`ignored_fields`.
At that point the job is running, so awx-axi exits **0** and reports it prominently rather than exiting
non-zero:

```
$ awx-axi template launch 18 --limit db-02
job:
  id: 1844
  template: 18 (Nightly patch)
  status: pending
warning: 1 field was ignored by the controller and the job is running without it
ignored[1]{field,submitted}:
  limit,db-02
help[2]: Run `awx-axi job cancel 1844` if this is not what you wanted,Run `awx-axi job watch 1844` to follow it to completion
```

Exiting non-zero here would be worse than the warning: an agent that reads a failure exit code while a job is
actually running is liable to launch it again.
The first help line is the cancel command for exactly that reason.

### 7.6 `workflow`

```
awx-axi workflow list                [--search] [--limit] [--fields]
awx-axi workflow show <id|name>
awx-axi workflow survey <id|name>
awx-axi workflow launch <id|name>    [--extra-vars] [--limit] [--scm-branch] [--wait] [--timeout] [--dry-run]
awx-axi workflow nodes <run-id>      the full node graph for one workflow run
```

Workflow **runs** live under `job` (§7.2), so there is no singular/plural pair like `workflow job` next to
`workflow jobs` for an agent to confuse.
`job show <workflow-run-id>` carries the node rollup inline (§8.3), and `workflow nodes` is the escape hatch
for the full graph with the success, failure, and always edges.

### 7.7 `approval` - an inbox, at top level

```
awx-axi approval list                [--all] [--limit]
awx-axi approval show <id>
awx-axi approval approve <id>        [--dry-run]
awx-axi approval deny <id>           [--dry-run]
```

Approvals are promoted to a top-level noun rather than living under `workflow` because they are the one thing in
AWX that is *waiting on a human decision*, which makes them an inbox.
`approval list` defaults to pending only; `--all` includes decided ones.
The home view surfaces the pending count for the same reason.

`approval show` prints what the step gates before anyone decides:

```
$ awx-axi approval show 57
approval:
  id: 57
  name: Prod release gate
  workflow: 1840 (Release pipeline)
  status: pending
  requested: 2026-07-27T14:02:11Z
  timeout: 3600
  expires: 2026-07-27T15:02:11Z
  blocks[2]{node,template}:
    9,Deploy web tier
    10,Smoke test
help[2]: Run `awx-axi approval approve 57` to release the 2 downstream steps,Run `awx-axi approval deny 57` to fail the workflow at this step
```

`blocks` comes from the workflow job's node list, and it is the difference between an informed approval and a
blind one.

### 7.8 `project`

```
awx-axi project list                 [--search] [--limit] [--fields]
awx-axi project show <id|name>
awx-axi project playbooks <id|name>
awx-axi project updates <id|name>    [--limit]
awx-axi project sync <id|name>       [--wait] [--timeout] [--dry-run]
```

The verb is `sync`, not `update`, so it cannot be read as "modify the project record".
A sync's log is `job stdout <sync-id>` (§7.2), and its progress is `job watch <sync-id>`.

### 7.9 `job watch` - bounded polling

```
$ awx-axi job watch 1843 --timeout 300
job:
  id: 1843
  name: Deploy web tier
  status: failed
  elapsed: 64.2
  hosts: 3 total, 1 failed, 2 ok
  waited: 68s
help[2]: Run `awx-axi job stdout 1843` for the tail of the output,Run `awx-axi job relaunch 1843 --failed-only` to retry the failed host
```

Polling, not websockets (§2).
The loop reads `status` and stops when it leaves AWX's active set (`new`, `pending`, `waiting`, `running`) -
awx-axi uses AWX's own definition rather than a hard-coded list, per §3.3.

`--interval` defaults to 5 seconds with exponential backoff to 30 for long runs, so a two-hour job costs
roughly 250 requests rather than 1440.
`--timeout` defaults to 600 seconds and is a hard ceiling: on expiry awx-axi exits 1 with `WATCH_TIMEOUT`, the
last observed status, and the command to resume watching.
It never blocks unbounded, because an agent that hangs is worse than one that reports a timeout.

Exit code follows the job: `successful` exits 0, `failed`, `error`, and `canceled` exit 1.
This is the one place where exit code reflects the *watched job's* outcome rather than the command's own, and it
is deliberate: `awx-axi job watch` is what a caller puts in a script that should fail when the playbook fails.
`--wait` on the launch commands is the same loop, so `template launch 12 --wait` launches and returns the
outcome in one call.

### 7.10 Request cost per command

Published because AXI §4's whole argument is that a follow-up call is the expensive thing, and a design that
hides its own call count cannot be held to that.

Counts price the **id** form of each command.
Every `<id|name>` argument adds **one** resolve query when a name is passed instead (§7.3), so
`template launch "Deploy web tier"` is 3 and `--wait` on it is 3 + N.
`type resolve` below is a different thing: it is the unified-job type lookup, which is needed even when the id
is numeric.

| Command | Requests | Note |
| --- | --- | --- |
| home view | 3 | running jobs, pending approvals, recent failures; 4 on first use, when the §4.2 version probe runs and is cached |
| `job list` | 1 | |
| `job show` (playbook) | 3 | type resolve, detail, host summaries |
| `job show` (failed playbook) | 4 | plus failed events for the task rollup |
| `job show --type job` | 2 | `--type` skips the resolve |
| `job show` (workflow run) | 3 | type resolve, detail, node list for the rollup |
| `job stdout` | 2 | type resolve, ranged stdout |
| `job cancel` | 2 | type resolve, POST; 3 when the POST returns 405 and the state must be read |
| `job watch` | 1 + N | one poll per interval |
| `template launch` | 2 | preflight GET, launch POST |
| `template launch --wait` | 2 + N | plus the poll loop |
| `approval approve` | 1 | 2 when the POST returns 400 and the decision must be read |
| `project sync` | 1 | POST; 2 on a 405 |

## 8. Output format

TOON on stdout, produced by `axi-sdk-js`'s CLI loop: a command handler **returns** a string or a plain object
and `runAxiCli` encodes it through `@toon-format/toon`'s `encode`.
awx-axi never imports an encoder helper, because at the pinned 0.1.8 there is none to import: `dist/index.js`
re-exports only `cli`, `errors`, `hooks`, and `update`, and the package's `exports` map admits no subpath, so
`renderOutput`, `errorOutput`, `renderError`, and `homeHeaderOutput` are reachable only by the loop itself
(§16).
Rendering by return value rather than by call is therefore the only shape available, and it is also the one
the other installed AXI tools use.

Three encoder facts were verified empirically against the pinned encoder rather than assumed from the spec,
because they change what the output can look like:

1. **A multi-line string encodes to one quoted line with `\n` escapes.**
   `content: "PLAY [web] ***\nTASK [ping] ***\nok: [db-02]\n"`.
   An array of lines is worse: primitive arrays encode inline, so 200 log lines become one comma-joined line
   with every embedded quote escaped.
   §8.4 is the consequence.
2. **`help[N]` encodes inline, comma-joined, on a single line.**
   The multi-line form in the AXI skill's examples is illustrative, not what `encode` emits.
   awx-axi accepts the encoder's form rather than hand-rolling TOON, which is also what the installed
   `lavish-axi` does.
   The practical consequence is a real budget on suggestions: two or three short ones, never five long ones.
3. **The keyed tabular form is not available at the pinned encoder version.**
   `{a: {x: 1}, b: {x: 2}}` encodes as nested objects, not `[2:]{x}:`.
   The pinned `@toon-format/toon` is 2.3.1, which develops against spec v3.3, while the published spec is
   v4.1.
   No output shape in this document depends on a v4-only form, and the version is pinned exactly rather than
   caret-ranged so an encoder upgrade is a deliberate, reviewed change with its own snapshot-test diff.

### 8.1 Home view

The home view is also the session-hook payload (§13), so it loads on every agent session and its token budget
is the tightest in the CLI.
Three blocks, hard-capped at 5 running, 5 pending approvals, and 3 recent failures, in 3 requests:

```
$ awx-axi
bin: ~/.local/bin/awx-axi
description: Inspect and run AWX automation from the shell
controller: awx.example.com (AWX 24.6.1)
running[2]{id,name,status,elapsed}:
  1841,Deploy web tier,running,142
  1842,Nightly patch,waiting,0
approvals[1]{id,workflow,waiting}:
  57,Release pipeline,18m
failures[2]{id,name,status,finished}:
  1839,Deploy db tier,failed,"2026-07-27T13:41:02Z"
  1837,"Patch: all hosts",error,"2026-07-27T12:10:44Z"
help[3]: Run `awx-axi job show <id>` for a job's result,Run `awx-axi approval show 57` to see what it gates,Run `awx-axi template list` to see what can be launched
```

The aggregates come from filtered list counts, never from the deprecated dashboard endpoint (§4.2).

A quiet controller states the zeros rather than printing nothing, per AXI §5:

```
$ awx-axi
bin: ~/.local/bin/awx-axi
description: Inspect and run AWX automation from the shell
controller: awx.example.com (AWX 24.6.1)
running: 0 jobs running
approvals: 0 approvals pending
failures: 0 failures in the last 24h
help[2]: Run `awx-axi job list` for recent job history,Run `awx-axi template list` to see what can be launched
```

### 8.2 List output

Default schemas are 4 fields.
The total from the envelope's `count` is always present, so an agent never paginates to find out how many there
are:

```
$ awx-axi job list --failed --limit 3
count: 3 of 47 total
jobs[3]{id,name,status,finished}:
  1839,Deploy db tier,failed,"2026-07-27T13:41:02Z"
  1838,"Sync inventory, nightly",failed,"2026-07-27T13:02:00Z"
  1837,"Patch: all hosts",error,"2026-07-27T12:10:44Z"
help[2]: Run `awx-axi job show <id>` for the failure detail,Run `awx-axi job stdout <id>` for the playbook output
```

Default limits are set from how AWX is actually used, not from the API's page size: 20 for `job list` (a
history scan), 100 for `template list`, `workflow list`, and `project list` (an agent wants the whole
inventory of launchable things in one call), 50 for `job events`.
`--fields` extends the schema from a per-subcommand allowlist; an unknown field name is a `VALIDATION_ERROR`
listing the valid names.

Empty results state the zero with the filter that produced it:

```
$ awx-axi job list --status failed --since 24h
jobs: 0 failed jobs in the last 24h
help[1]: Run `awx-axi job list --status all` for all recent jobs
```

### 8.3 Detail output and pre-computed aggregates

`job show` spends one extra request on the host rollup, and a second on failed events when the job failed,
because those are the two things a caller asks for next essentially every time:

```
$ awx-axi job show 1839
job:
  id: 1839
  type: job
  name: Deploy db tier
  status: failed
  template: 13 (Deploy db tier)
  launched_by: btsai
  started: "2026-07-27T13:39:58Z"
  elapsed: 64.2
  hosts: 3 total, 2 ok, 1 failed, 0 unreachable
  failed_tasks[1]{host,task}:
    db-02,Restart postgresql
  stdout: 4212 lines
help[2]: Run `awx-axi job stdout 1839` for the tail of the output,Run `awx-axi job relaunch 1839 --failed-only` to retry only db-02
```

For a workflow run the same command carries the node rollup, which AWX makes free: each node's
`summary_fields` already contains its job status and template name, so the whole graph state costs one request
and no per-node follow-up.

```
$ awx-axi job show 1840
job:
  id: 1840
  type: workflow_job
  name: Release pipeline
  status: running
  elapsed: 1204.5
  nodes: 6 total, 3 successful, 1 running, 1 pending approval, 1 not run
  blocked_on[1]{node,approval}:
    8,57
help[2]: Run `awx-axi approval show 57` to see what is blocking it,Run `awx-axi workflow nodes 1840` for the full node graph
```

`blocked_on` is the derived field that answers "why has this been running for twenty minutes", which is the
actual question behind a stalled workflow.

### 8.4 Log output: a raw region after a TOON header

Log text does not go through the encoder, for the reason verified in §8: a 200-line body becomes one
unreadable escaped line, and token cost rises rather than falls.

A handler that returns a **string** has it written through verbatim instead of encoded, which is the sanctioned
seam.
So `job stdout` emits an encoded header, then the literal `stdout:` marker, then the **raw log body**, then an
encoded help block:

```
$ awx-axi job stdout 1839
job_stdout:
  id: 1839
  name: Deploy db tier
  status: failed
  lines: 4013-4212 of 4212
stdout:
PLAY [db] **********************************************************
TASK [Restart postgresql] ******************************************
fatal: [db-02]: FAILED! => {"changed": false, "msg": "Unit not found"}
PLAY RECAP *********************************************************
db-02  : ok=3  changed=1  unreachable=0  failed=1
help[2]: Run `awx-axi job stdout 1839 --lines 1-200` to read from the start,Run `awx-axi job events 1839 --failed` for the failing tasks only
```

The region between `stdout:` and the `help` line is **raw text, not TOON**, and that is a deliberate,
documented exception rather than an oversight.
It is the one place in the CLI where output is not encoder-produced.
The header carries the line range and total so AXI §3's "how much am I missing" is answered in machine-readable
form, and the raw region stays readable.

**The default is the tail, not the head.**
`--tail 200` is the default because a failed playbook's cause is at the end; `--lines 1-200` reads from the
start; `--full` requests everything, which is the case §9's `OUTPUT_TOO_LARGE` guards.
`--download <path>` writes the body to a file through the download renderer, which is the only endpoint that
bypasses AWX's 1 MiB display cap.

Every log body passes through the §6.4 redaction pass on the way out.

### 8.5 Mutation output

A mutation prints the resulting object plus the next step, never a bare success message:

```
$ awx-axi job cancel 1841
job:
  id: 1841
  name: Deploy web tier
  status: canceled
  elapsed: 154.8
help[1]: Run `awx-axi job relaunch 1841` to run it again
```

And the idempotent no-op case, which AXI §6 requires be an exit-0 acknowledgement rather than an error:

```
$ awx-axi job cancel 1839
job: 1839 already finished (failed), nothing to cancel (no-op)
help[1]: Run `awx-axi job relaunch 1839` to run it again
```

Producing that line requires the §9.2 disambiguation: AWX answers the cancel with a bare 405, so awx-axi reads
the job's state to find out *why* before it can say anything true.

## 9. Errors and exit codes

Errors are TOON on **stdout**.
A command constructs an `AxiError` from `axi-sdk-js` carrying the message, the stable code, and the help lines,
and throws it; `runAxiCli` catches it, renders the block below, and sets the exit code.
awx-axi never formats an error itself, for the §8 reason: the rendering helpers are internal to the SDK at
0.1.8.

```
error: <what went wrong>
code: <STABLE_CODE>
help[N]: <actionable next command>,<another>
```

Exit codes: `0` success including empty results and no-ops, `1` error, `2` usage error.
`exitCodeForError` returns 2 for the literal code `VALIDATION_ERROR` and 1 for everything else, so it cannot
by itself serve the three other codes in §9.1 that must exit 2: `AMBIGUOUS_NAME`, `LAUNCH_WOULD_IGNORE_INPUT`,
and `LAUNCH_INPUT_REQUIRED`.
awx-axi therefore passes its own `formatError` to `runAxiCli` - a documented option on `AxiCliOptions` that
returns the rendered output and the exit code together - and maps those four codes to 2 there.
The alternative, collapsing the three into `VALIDATION_ERROR`, is rejected: the stable code is the part an
agent branches on, and §9.1 exists to keep it stable.

stderr carries nothing an agent needs: progress and diagnostics only, per AXI §6.

### 9.1 Error code table

| Code | Cause | Exit |
| --- | --- | --- |
| `VALIDATION_ERROR` | Unknown flag or subcommand, missing required argument, malformed `--lines` range, non-positive `--limit`, unknown `--type` or `--fields` name, `--extra-vars` that is neither valid JSON nor valid YAML, mutually exclusive flags | 2 |
| `AMBIGUOUS_NAME` | A name matched more than one object; candidates are printed | 2 |
| `LAUNCH_WOULD_IGNORE_INPUT` | Preflight found a submitted field the template does not prompt for (§7.5) | 2 |
| `LAUNCH_INPUT_REQUIRED` | Preflight found unsatisfied `variables_needed_to_start`, or a credential password is needed and the §6.3 gate is closed | 2 |
| `AUTH_REQUIRED` | No credential resolved, or the controller returned 401 | 1 |
| `FORBIDDEN` | 403: authenticated but not permitted, including a user who cannot approve | 1 |
| `NOT_FOUND` | 404 on a numeric id | 1 |
| `NAME_NOT_FOUND` | A name matched zero objects; help notes that an invisible object is indistinguishable from a missing one | 1 |
| `LAUNCH_REJECTED` | 400 from a launch endpoint, with AWX's field errors translated | 1 |
| `ALREADY_DECIDED` | Approve on a denied approval, or deny on an approved one: the requested state cannot be reached | 1 |
| `SYNC_UNAVAILABLE` | 405 from project sync because the project has no SCM source to sync from | 1 |
| `OUTPUT_TOO_LARGE` | Output above AWX's display cap (§4.3 case 4) | 1 |
| `WATCH_TIMEOUT` | `job watch` or `--wait` exceeded `--timeout`; the last observed status is reported | 1 |
| `CONTROLLER_UNREACHABLE` | DNS failure, connection refused, or connect timeout | 1 |
| `TLS_UNTRUSTED` | Certificate verification failed | 1 |
| `SERVER_BUSY` | 502, 503, or 504 after backoff exhausted | 1 |
| `SERVER_ERROR` | 500 | 1 |
| `READ_ONLY_VIOLATION` | A mutating request was attempted while the §6.5 read-only flag was set; the method and route are named and nothing was sent | 1 |
| `UNKNOWN` | Anything unmapped | 1 |

Two outcomes are deliberately **not** in this table, because they are exit-0 no-ops per AXI §6:
cancelling a job that already finished, and approving an approval that is already approved.

### 9.2 The 405 disambiguation

AWX answers both "this job already finished" and "this project can never be synced" with a bare **405 Method
Not Allowed** and no body.
Printing 405 to an agent is useless, and guessing is worse.
So a 405 on a tier-1 write triggers **one follow-up read** of the object's current state, and the outcome
splits:

| Command | Object state after the 405 | Result |
| --- | --- | --- |
| `job cancel` | Terminal status | exit 0, `already finished (<status>), nothing to cancel (no-op)` |
| `job cancel` | Active status | exit 1, `SERVER_ERROR`: a cancelable job refused cancellation |
| `project sync` | A sync already running | exit 0, no-op naming the running sync's id |
| `project sync` | `scm_type` empty | exit 1, `SYNC_UNAVAILABLE`: this project has no SCM source |

The extra request is the price of telling the truth, and §7.10 publishes it.

### 9.3 Translation, not passthrough

Raw AWX payloads never reach stdout.
`core/errors.ts` holds a pattern table keyed on status code plus body shape, mapping to an `AxiError` whose
message and suggestions reference `awx-axi` commands only, never `awx`, never a REST route.

AWX's three body shapes are handled explicitly: a field-error dict `{"field": ["message"]}`, the non-field key
`__all__`, and a permission `{"detail": "..."}`.

```
$ awx-axi template launch 12 --extra-vars '{"env":"prod"}'
error: template 12 rejected the launch: survey question "approver" is required
code: LAUNCH_REJECTED
help[2]: Run `awx-axi template survey 12` to see the required questions,Re-run with --extra-vars '{"env":"prod","approver":"<name>"}'
```

```
$ awx-axi job stdout 1839 --full
error: this job's output is 3.2 MB, above the controller's 1.0 MB display limit
code: OUTPUT_TOO_LARGE
help[2]: Run `awx-axi job stdout 1839 --download ./1839.log` to fetch the whole thing,Run `awx-axi job events 1839 --failed` for the failing tasks only
```

Neither remedy is a narrower read of the same endpoint, and that is deliberate.
The 1 MiB check in §4.3 case 4 is applied to the **whole** body before any range is honored: the oversized
response comes back with `range` `{start: 0, end: 1, absolute_end: 1}` whatever `start_line` and `end_line`
asked for.
So `--tail 200` on a 3.2 MB job re-trips the same cap and returns the same error, which would put an agent in a
retry loop.
`--download` is the only escape from the cap (§8.4), and `job events --failed` answers the question behind most
of those reads without touching the stdout endpoint at all.

That example is only possible because §4.3 case 4 is handled: the controller returned **200** with an
English apology, and awx-axi recognized the shape instead of printing it as job output.

### 9.4 Unknown flags fail loud

Per AXI §6, an unknown flag is rejected by name before any HTTP call, with the subcommand's valid flags inlined
so the correction takes one turn:

```
$ awx-axi job list --state failed
error: unknown flag --state for `job list`
code: VALIDATION_ERROR
help[2]: Did you mean --status?,valid flags for `job list`: --status, --type, --template, --failed, --since, --limit, --fields
```

Flag sets are declared per subcommand, not per noun, because `job list` and `job stdout` share nothing.
`--help` always passes.
Renamed flags get a targeted hint rather than the generic list.

## 10. Module boundaries and the stable core

### 10.1 Layout

```
src/
  bin/awx-axi.ts        entry point; delegates to runAxiCli from axi-sdk-js
  cli.ts                the DOMAINS list: the registered noun to domain-module map
  core/
    auth.ts             credential resolution, token minting, AUTH_REQUIRED mapping
    transport.ts        the AwxTransport seam; status codes preserved to the caller
    paginate.ts         envelope walking, count reporting, the page_size and count_disabled rules
    resolve.ts          id-or-name resolution, ambiguity, unified-job type resolution
    output.ts           TOON helpers: list, detail, count line, truncation, the raw-body region
    errors.ts           status-plus-body to AxiError pattern table
    redact.ts           SCM-URL and $encrypted$ redaction for log bodies
    poll.ts             the watch loop: backoff, active-state detection, timeout
    flags.ts            per-subcommand known-flag validation and the secret-name guard
    registry.ts         the domain contract types and the shared list/detail pipeline
  commands/             auth, home, setup
  domains/
    job/                list, show, stdout, events, hosts, cancel, relaunch, watch
    template/           list, show, survey, launch
    workflow/           list, show, survey, launch, nodes
    approval/           list, show, approve, deny
    project/            list, show, playbooks, updates, sync
    inventory/          list, show, groups, hosts, sources, updates, constructed-list
  skill/                generated SKILL.md and the --check drift guard
test/
  fixtures/             recorded AWX 24.6.1 responses
  live/                 opt-in READ-ONLY live smoke suite, gated on AWX_AXI_LIVE=1 (§6.5)
bench/                  the §14.3 comparison harness against the plain awx CLI
```

The noun-to-domain map lives in `src/cli.ts` rather than in `core/registry.ts`, because every domain imports
`core/registry.js` for the contract types and holding the list there would be a circular import.

### 10.2 The contract that keeps this extensible

**A domain module never speaks HTTP and never imports another domain.**

Each domain exports exactly five things:

1. Its subcommands, and the known flag set for each, consumed by `core/flags.ts`.
2. Route descriptions: the path and query it needs, returned as data, not executed.
3. Its TOON field schemas, including the `--fields` allowlist and which derived aggregates it wants.
4. Its contextual-disclosure suggestions, as a match table.
5. `mcpEquivalents: string[]`, the awx-mcp tool names it covers, which §14.2's drift tool consumes.

Everything else - auth, pagination, retry, error translation, redaction, TOON encoding, exit codes, help
dispatch - lives in the core and is written once.

The consequences that matter:

- Adding a domain is one directory under `src/domains/` plus one entry in `DOMAINS`.
  No core change, no cross-domain edit.
  Growing from v1's 6 domains toward the §14 roadmap does not touch the core.
- Because domains return route descriptions rather than executing them, every domain is unit-testable with no
  network and no mocking framework.
- Because error translation is centralized, a new AWX error shape is fixed once for every command.
- Because no domain declares a `DELETE` route and `registry.ts`'s route type does not include the verb, §2's
  no-deletes property is enforced by the type system rather than by review.

### 10.3 The transport seam

```ts
interface AwxResponse {
  status: number;                 // load-bearing: 202, 204, 400, 405 all carry meaning
  headers: Headers;
  body: unknown;                  // parsed JSON, or undefined for 204
}

interface AwxTransport {
  get(route: string, query?: Query): Promise<AwxResponse>;
  post(route: string, body?: unknown): Promise<AwxResponse>;   // refused when readOnly
  getPaged(route: string, query: Query, limit: number): Promise<PagedResult>;
  getText(route: string, query?: Query): Promise<TextResponse>;
}
```

`post` is the only mutating method on the seam, because §2's no-deletes property means no `del`, `put`, or
`patch` method exists to call.
`HttpTransport` checks the §6.5 read-only flag inside `post` and raises `READ_ONLY_VIOLATION` before issuing
anything.
Putting the check here rather than in each domain is what makes it a guarantee: there is exactly one function in
the codebase that can mutate a controller, and it is four lines long.

`status` is on the response rather than swallowed into a thrown error precisely because §3.2 is the design's
central argument: the status code *is* the semantics for cancel, sync, approve, and launch.
A transport that threw on every non-2xx would put the 405 disambiguation out of reach.

`getPaged` takes the caller's row limit, not a page size.
It walks the envelope's `next` links until it has that many rows and returns one assembled result plus the
server's `count`, so no domain and no command ever sees a page boundary.
It never sends `count_disabled` (§4.3 case 2).

`getText` handles the stdout endpoints, including detecting the oversized-output apology (§4.3 case 4) and
returning it as a typed condition rather than as content.

There are exactly two implementations: `HttpTransport` on Node's native `fetch`, and `RecordedTransport` for
tests.
That single interface is what makes §11 possible.

## 11. Offline testability and the live-smoke seam

### 11.1 The constraint, stated honestly

A real AWX instance and credentials **are** available (§6.5), but only under the hard read-only boundary, and
the `awx` CLI is **not** installed on the development machine.
So the shape of the constraint is not "no instance" but "no writes, ever, and no comparison arm yet".

Every test that gates the build runs offline against fixtures derived from the 24.6.1 source.
The live suite (§11.3) is read-only, asserts shape rather than content, and is deliberately not the thing the
build depends on.
This limitation belongs in the README, not buried here.

The benchmark the commission asks for (§14.3) still needs the `awx` CLI installed to have anything to compare
against, so it remains blocked on that one step; both of its arms are read-only tasks when it does run.
Nothing here blocks the core work.

### 11.2 How offline testing works

Domain tests inject `RecordedTransport` and assert on emitted TOON.
Since domains are pure functions from arguments to route descriptions and from responses to TOON, this covers
the whole command surface with no network.

Fixtures live in `test/fixtures/` and follow the shapes the 24.6.1 serializers actually produce.
**Each fixture file records the source file and line it was derived from**, so a fixture can be re-verified
against the tag rather than trusted.

The highest-value tests are the ones covering §4.3, because those are the behaviors that make a naive client
quietly wrong:

- **The 405 disambiguation.**
  Four scripted cases matching §9.2's table, asserting exit 0 with a no-op line for a finished job and a
  running sync, and exit 1 with the right code for the other two.
- **The oversized-stdout apology.**
  A fixture returning HTTP 200 whose `content` is the apology sentence and whose `range.absolute_end` is 1.
  Asserts `OUTPUT_TOO_LARGE` and exit 1, and specifically asserts that the apology text never appears on
  stdout as job output.
- **The launch preflight.**
  A template fixture with `ask_limit_on_launch` false, asserting that `--limit` produces
  `LAUNCH_WOULD_IGNORE_INPUT` at exit 2 and that **no POST was issued**.
  Its companion drives the race: preflight passes, the launch response carries a non-empty `ignored_fields`,
  and the assertion is exit **0** with the warning block and the cancel suggestion.
- **Pagination.**
  `--limit 450` against a three-page fixture, asserting three requests, exactly 450 assembled rows, the
  server's `count` in the output, and that `count_disabled` appears in no request.
  A companion asserts that an oversized `page_size` request still reads correctly when the server caps it.
- **Event-list pagination.**
  Asserts `job events` sends `page_size` and not `limit`, so `count` survives.
- **Name resolution.**
  Zero, one, and two matches, asserting `NAME_NOT_FOUND`, success, and `AMBIGUOUS_NAME` with candidates.
  Plus the case AWX itself gets loose about: two same-named templates must produce the refusal, never the
  oldest match.
- **Error translation.**
  Raw AWX bodies for a field-error dict, an `__all__` non-field error, and a `{"detail": ...}` permission
  error, asserting the translated output. This is the layer most likely to leak dependency noise.
- **Redaction.**
  A project-update log fixture containing `https://user:token@github.com/org/repo` asserting the credential
  is gone from stdout.
- **The secret-name guard.**
  A unit test asserting that declaring a flag named `--token` throws at registration.

### 11.3 The live smoke suite is read-only, and there is no write suite

A real controller is now available, under the hard read-only boundary in §6.5.
That boundary shapes this suite more than anything else in the design.

`test/live/` runs only when `AWX_AXI_LIVE=1`, and its harness **sets
`AWX_AXI_READ_ONLY=1` itself** rather than trusting the environment to carry it.
It uses `HttpTransport` with basic auth sourced from `~/.config/awx-axi/live-smoke.env`, because minting a token
is a `POST` and therefore forbidden (§5.1).
It asserts **shape, not content**: every command exits 0 or a documented code, stdout parses, and required keys
are present.
It never asserts on specific job, template, project, or host names, so it stays valid as the instance's contents
change and so no instance detail is baked into the repository.

**There is no write-path suite, at any gate, in v1.**
An earlier draft of this design proposed one behind a second environment variable.
It is removed rather than merely disabled: a gate that exists can be opened by a future contributor who has not
read the captain's order, and the whole point of §6.5 is that the guarantee must not depend on someone
remembering.
The seven tier-1 write commands are therefore covered **only** by the offline suite, which is where they were
already covered anyway (§11.2), and by `--dry-run` against the live instance, which issues no mutation and is a
genuinely useful live check of name resolution and payload construction.

Coverage cost, stated plainly: nothing in v1 will ever have executed a real launch, cancel, sync, or approval
against a real controller.
Those paths are exercised against recorded fixtures and reasoned from the 24.6.1 source, and that is the honest
limit of the evidence behind them.
When the captain wants that verified, it needs a disposable instance or an explicit, scoped authorization, and
it is a separate conversation rather than a flag.

The suite doubles as a fixture recorder, which is read-only and therefore permitted: `AWX_AXI_RECORD=1` writes
GET responses into `test/fixtures/` with the controller hostname, organization names, inventory hostnames, and
any `$encrypted$` field scrubbed.
A recorder-specific test asserts that no recorded fixture contains the credential file's username or any value
sourced from it, so the §6.5 no-values-anywhere rule is checked rather than trusted.

The whole live validation is:

```
set -a; . ~/.config/awx-axi/live-smoke.env; set +a
AWX_AXI_LIVE=1 npm run test:live
```

No `auth login`, and no exported credential values beyond that subshell.

## 12. Implementation stack

Node.js with TypeScript, ESM, matching the other installed AXI tools.

- **`axi-sdk-js`** (pinned `0.1.8`) for the CLI loop - which owns TOON rendering, the home-view header, and
  error rendering - plus `AxiError`, `exitCodeForError`, the reserved `update` command, and
  `installSessionStartHooks`.
  Those are the symbols the package actually exports (§16); everything else it does is reached by returning a
  value to the loop or throwing an `AxiError` at it.
  Adopting it rather than reimplementing keeps awx-axi consistent with `gh-axi`, `tasks-axi`, `quota-axi`,
  `lavish-axi`, and `chrome-devtools-axi` in command shape, flag conventions, output shape, help text, and
  error style.
- **`@toon-format/toon`** pinned to exactly `2.3.1`, matching the version the other installed AXI tools use.
  Pinned, not caret-ranged, for the §8 reason: the encoder's emitted syntax is part of awx-axi's observable
  output, and the published spec has already moved ahead of this version.
- **Node's native `fetch`** for HTTP. No axios, no undici dependency.
  AWX's API is plain JSON over HTTPS and a client library would add weight plus a second error vocabulary
  without removing work.
- **`vitest`** for tests, with fixtures as plain JSON and no mocking framework, since `RecordedTransport` is
  the only seam any test needs.
- **No awxkit, no Python.** Per §3.
- **No YAML library unless `--extra-vars` genuinely needs it.**
  AWX preserves `extra_vars` formatting in both directions, so awx-axi can pass a JSON string through
  untouched. YAML input support is a follow-up decision, not a v1 dependency.

## 13. Session integration and skill

Per AXI §7, both integration paths ship, and both are opt-in through an explicit setup command:

`awx-axi setup hooks`

The hook runs the home view (§8.1) at session start, so an agent opens every session already knowing what is
running, what needs an approval decision, and what recently broke.
`installSessionStartHooks` from `axi-sdk-js` handles all three targets, including the path-repair and
idempotency rules AXI §7 requires.

The hook has a failure mode worth designing for: an unreachable controller or an expired token must **not**
break session start.
On any error the hook prints a single line naming the problem and the fix, and exits 0.

The installable skill is generated from the same content the home view prints, with live state stripped, and
`npm run skill:check` fails CI when the committed `SKILL.md` drifts from the generator.

## 14. Coverage against awx-mcp, and roadmap

### 14.1 What v1 covers

`lycorp-jp/awx-mcp` is the feature checklist.
The inventory captured for this design enumerates **145 tools**; the commission cites 146.
The design tracks the enumerated list and treats the one-tool delta as an open item for §14.2's tool to
reconcile against the upstream repository when it is built, rather than silently picking a number.

v1 implements **40 of those tools** across 6 domains:

| awx-mcp group | Tools | v1 covers | awx-axi commands |
| --- | --- | --- | --- |
| Jobs | 7 | 7 | `job list/show/stdout/events/hosts/cancel/relaunch` |
| Job Templates | 13 | 4 | `template list/show/survey/launch` |
| Workflow Templates & Nodes | 17 | 4 | `workflow list/show/survey/launch` |
| Workflow Jobs & Approvals | 11 | 9 | `job list/show/cancel/relaunch`, `workflow nodes`, `approval list/show/approve/deny` |
| Projects | 11 | 8 | `project list/show/sync/playbooks/updates`, `job stdout/cancel/show` |
| Inventories | 8 | 8 | `inventory list/show/groups/hosts/sources/updates/constructed-list/constructed-show` |

The unified-job collapse (§7.2) is why the Projects row reaches 8 with only 5 project commands: project-update
list, get, cancel, and stdout are served by the `job` noun.
The same mechanism means `job watch`, which has no awx-mcp equivalent at all, works for every kind of run.

### 14.2 Tracking the rest

The remaining 105 tools (145 total against v1's 40) are roadmap, not omissions, and they are tracked in code
rather than in prose.
The seven groups enumerated below account for 86 of those 105; the balance is an ungrouped long tail that the
coverage diff reports rather than this document enumerating it.

Each domain declares `mcpEquivalents`.
A `npm run coverage` script diffs the union of those declarations against a committed snapshot of the awx-mcp
tool list and prints the delta in TOON.
CI runs it in `--check` mode so a new domain that forgets its declaration fails the build, and a refreshed
upstream snapshot shows up as a reviewable diff rather than as silent drift.

Roadmap order, by what unblocks the most operator work per domain added:

1. **Inventories, hosts, groups** (26 tools) - read first.
   `job hosts` already answers "which host failed"; the follow-up is "what else is in that group".
2. **Schedules** (5) - read-only first.
   The natural question after "what ran" is "what will run".
3. **Ad hoc commands** (3) - read now, execute only behind a §6-style gate.
4. **Organizations, teams, RBAC** (17) - reads only; grants stay out.
5. **Execution environments, instances, notifications, labels** (14).
6. **System jobs and activity stream** (9+) - `job` already reads system jobs; the activity stream is the audit
   surface.
7. **Credentials and users** (12) - reads before writes, and writes only under an explicit captain decision.

### 14.3 Where awx-axi should win, and where awx-mcp will

The commission asks for a benchmark against the plain `awx` CLI on success rate, token cost, duration, and
turns, in the shape the AXI repo benchmarks `gh-axi` against `gh`.
`bench/` holds that harness, and it needs a live controller, so it lands after the core commands work.

**Every benchmark task is a read-only question, under §6.5.**
The harness sets `AWX_AXI_READ_ONLY=1` for the awx-axi side, and the comparison tasks given to the plain `awx`
CLI are restricted to read verbs by the same rule, since a benchmark that mutated the controller through the
comparison arm would breach the boundary just as surely as one that mutated it through ours.
That constrains what the benchmark can claim, and the "fewer wrong launches" hypothesis below is where it bites.

The hypotheses it should test, stated in advance so the benchmark cannot be tuned to flatter the result:

- **Fewer turns on the common questions.**
  "What broke in the last two hours" is one `job list --type all --failed --since 2h` call, against four list
  operations plus a client-side merge.
- **Fewer tokens per answer.**
  4-field TOON rows against full JSON serializer payloads, on a surface where AWX offers no sparse fieldsets so
  every alternative pays full payload cost at the model.
- **Fewer wrong launches - measured offline, not live.**
  The §7.5 preflight is the design's one measurable safety claim, and the natural way to demonstrate it is to
  pass `--limit` to a template that does not prompt for it and watch awx-axi refuse while everything else
  launches with the wrong scope.
  That experiment **launches a real playbook**, so it cannot run against the captain's instance.
  It moves to the offline suite as a paired fixture case, and the benchmark reports it as offline evidence
  rather than quietly dropping the claim or quietly running it live.
- **Where awx-mcp stays ahead.**
  It has 145 tools to v1's 32, so any task touching inventories, credentials, schedules, or RBAC is out of
  awx-axi's reach entirely.
  It also has MCP's form-mode elicitation for sensitive input, which is a genuinely better secret channel than
  anything a CLI can offer; §6.3's gated file is a weaker substitute, and the benchmark should say so rather
  than skip the comparison.

## 15. Deliberate judgment calls

1. **REST API v2, not a wrapper around the `awx` CLI.**
   Because AWX's status codes carry semantics that a CLI wrapper discards (§3.2), and because a Node CLI with
   no Python runtime fits the installed AXI toolchain.
   The cost is owning an HTTP client, a pagination walk, and a poll loop; §3.4 says so plainly.
2. **One `job` noun for all six kinds of AWX run.**
   Costs one type-resolution request per detail command and buys cross-kind queries, one log command, one
   cancel command, and one watch command instead of six sets.
3. **Workflow runs live under `job`, not under `workflow`.**
   Avoids a `workflow job` / `workflow jobs` singular-plural pair, which is a known agent-confusion trap.
   `workflow` is templates and launching; `workflow nodes` is the graph escape hatch.
4. **`approval` is top-level, not `workflow approval`.**
   It is an inbox of decisions waiting on a human, which makes it a first-class noun and worth surfacing in the
   home view.
5. **The launch preflight is mandatory, with no skip flag.**
   One GET is worth less than one playbook run against the wrong hosts, and an agent offered a skip flag will
   use it. §7.5.
6. **A launch that ignored a field exits 0, not 1.**
   The job is running; a non-zero exit invites a relaunch. The warning block plus a cancel suggestion is the
   safer shape. §7.5.
7. **`job stdout` defaults to the tail, not the head.**
   A failed playbook's cause is at the end. `--lines 1-200` is the head.
8. **Log bodies bypass the TOON encoder.**
   Verified empirically: multi-line strings become one escaped line and arrays of lines become one comma-joined
   line, so encoding a log costs tokens and destroys readability at once.
   The raw region after a TOON header is documented as the one non-encoded output in the CLI. §8.4.
9. **The TOON encoder version is pinned exactly, not caret-ranged.**
   Its emitted syntax is observable output, the installed version develops against spec v3.3 while the
   published spec is v4.1, and the keyed tabular form is not available. §8.
10. **`help[N]` stays in the encoder's inline form.**
    The AXI skill's multi-line examples are illustrative; matching them would mean hand-rolling TOON.
    The real constraint this imposes is two or three short suggestions, never five long ones.
11. **A 405 costs one extra read rather than a guess.**
    Cancel-on-finished and sync-on-non-SCM are the same status code, and one of them is an exit-0 no-op while
    the other is an error. §9.2.
12. **Names resolve by filtered query, never by named URL.**
    A named-URL 403 is rewritten to 404, and formats vary per controller.
    A filtered query returns a count, which is what makes the ambiguous case reportable. §7.3.
13. **Ambiguous names are refused, even though AWX itself resolves them.**
    AWX returns the oldest match for a legacy bare-name template lookup.
    Silently picking one of two production templates is the exact failure AXI §6 exists to prevent.
14. **`count_disabled` is never sent.**
    It would drop the total count that AXI §4's `count: N of M total` line depends on.
15. **No deletes, enforced by the route type rather than by review.**
    §2 and §10.2.
16. **Secrets cannot be flags, enforced by a registration-time guard.**
    A name-pattern check in `core/flags.ts` that fails its own unit test if someone adds `--token`. §5.3.
17. **`job watch` has a hard default timeout of 600s and exits with the job's outcome.**
    An agent that hangs is worse than one that reports a timeout, and a watch command is what a caller puts in
    a script that should fail when the playbook fails. §7.9.
18. **awx-axi redacts log output itself.**
    AWX applies URI cleaning only on the download renderer, so the paths awx-axi reads are not guaranteed
    clean. §6.4.
19. **Aggregates come from filtered counts, not the dashboard endpoint.**
    `/api/v2/dashboard/` is deprecated at 24.6.1, and awx-mcp's stats tool targets it. §4.2.
20. **The benchmark's hypotheses are written before the benchmark runs.**
    Including the two places awx-mcp is expected to stay ahead. §14.3.
21. **The live instance's read-only boundary is enforced at the transport, not promised in prose.**
    The captain's instance has full write permission and must not be modified, so `AWX_AXI_READ_ONLY=1` makes the
    single mutating function on the seam refuse before issuing anything.
    A document that only *says* read-only is one forgetful contributor away from being wrong. §6.5.
22. **The write-path live suite is deleted, not gated.**
    An earlier draft put it behind a second environment variable.
    A gate that exists can be opened by someone who never read the order, so the suite is gone and the coverage
    cost is stated openly instead. §11.3.
23. **The live suite uses basic auth, inverting §5.1's own rule.**
    Minting a token is a `POST`, so the tool's preferred credential path is itself forbidden on this instance.
    The exception is confined to `test/live/` and is the reason the read-only check lives in the transport rather
    than the auth layer. §5.1, §6.5.
24. **The preflight safety claim is demonstrated offline rather than dropped.**
    Proving it live would require launching a real playbook with a deliberately wrong scope.
    The benchmark reports it as offline evidence and says so, rather than quietly omitting the strongest claim in
    the design. §14.3.

## 16. Sources consulted

All AWX source citations are from `github.com/ansible/awx` at tag **24.6.1**, read on 2026-07-27.
The published automation-controller HTML docs 301 to a host that 404s these paths, and the Red Hat
`html-single` mirror rejects automated fetches; the docsite RST source **at the tag** is the working
authoritative substitute and is what §4's table is built from.

| Fact | Source at tag 24.6.1 |
| --- | --- |
| Pagination envelope, `page_size`, `MAX_PAGE_SIZE=200` | `docs/docsite/rst/rest_api/pagination.rst`; `awx/settings/defaults.py:369` |
| Default page size 25, auth classes, exception handler wiring | `awx/settings/defaults.py:370-390` |
| `count_disabled`, `DisabledPaginator`, `cap_page_size`, `LimitPagination` | `awx/api/pagination.py:16-131` |
| Filter lookups, `not__`/`or__`/`chain__`, `role_level` | `docs/docsite/rst/rest_api/filtering.rst` |
| `search` and `related__search`; `order_by` | `docs/docsite/rst/rest_api/{searching,sorting}.rst` |
| Trailing-slash 301; `extra_vars` formatting preserved | `docs/docsite/rst/rest_api/conventions.rst` |
| Token minting, bearer header, basic auth, SSO token restriction | `docs/docsite/rst/rest_api/authentication.rst` |
| Token lifetime, `ALLOW_OAUTH2_FOR_EXTERNAL_USERS` | `awx/settings/defaults.py:422-423` |
| Job status set; project and inventory-source extras | `awx/main/models/unified_jobs.py:76-107` |
| `CAN_CANCEL` / `ACTIVE_STATES`; `can_cancel` | `awx/main/constants.py:44-45`; `awx/main/models/unified_jobs.py:1450` |
| stdout formats, `start_line`/`end_line`, `absolute_end`, the oversized-output 200, download bypass, project-update URI cleaning | `awx/api/views/__init__.py:4177-4247` |
| Display caps 1048576 and 1024 | `awx/settings/defaults.py:202,217` |
| Launch GET fields, POST fields, 201 shape, `ignored_fields`, `passwords_needed_to_start` 400 | `awx/api/views/__init__.py:2410-2521`; `awx/api/serializers.py:4567-4607` |
| Cancel 202 and the 405 on a non-cancelable job | `awx/api/generics.py:1006-1020` |
| Project sync 202, the 405, the empty-400 | `awx/api/views/__init__.py:1057-1075` |
| Approval approve/deny 204 and the already-decided 400 | `awx/api/views/__init__.py:4524-4551` |
| Workflow job node fields and `summary_fields` rollup | `awx/api/serializers.py:4282-4304` |
| Job event fields | `awx/api/serializers.py:4413-4437` |
| Named URL formats, escaping, job-template legacy behavior | `docs/named_url.md` |
| Named-URL 403-to-404 rewrite | `awx/api/views/__init__.py:150-169` |
| Dashboard endpoint deprecated | `awx/api/views/__init__.py:172-174` |
| `GET /api/` returns the API version list and no release; the release comes from `GET /api/v2/ping/`, which needs no authentication | `awx/api/views/root.py:47-61` (`ApiRootView.get`); `awx/api/views/root.py:145-161` (`ApiV2PingView`, `permission_classes = (AllowAny,)`, `authentication_classes = ()`, `version=get_awx_version()`) |
| Bulk endpoints and the hidden wrapper workflow | `docs/bulk_api.md` |
| No sparse fieldsets | Absence of any `fields` query handling in `awx/api/generics.py` and `awx/api/serializers.py` |

Other sources:

| Fact | Source |
| --- | --- |
| The 10 AXI principles | the user-level `axi` skill |
| TOON syntax, quoting, escapes, tabular and keyed-tabular forms | `toonformat.dev/reference/syntax-cheatsheet.md`; spec v4.1 index at `toonformat.dev/reference/spec.html` |
| Encoder behavior for multi-line strings, inline primitive arrays, and the absent keyed-tabular form | Verified empirically against the installed `@toon-format/toon` 2.3.1 on 2026-07-27 |
| Encoder targets spec v3.3 | `@toon-format/toon@2.3.1` `devDependencies` |
| `axi-sdk-js@0.1.8` root exports: `runAxiCli`, `AxiError`, `exitCodeForError`, `installSessionStartHooks`, `RESERVED_COMMANDS`, the `update` helpers | `axi-sdk-js@0.1.8` `dist/index.js`; verified by importing the installed package on 2026-07-28 |
| The rendering helpers `renderOutput`, `errorOutput`, `renderError`, `homeHeaderOutput` exist but are **not importable**: `dist/index.js` does not re-export `./output.js`, and the `exports` map rejects `axi-sdk-js/dist/output.js` with `ERR_PACKAGE_PATH_NOT_EXPORTED` | `axi-sdk-js@0.1.8` `dist/index.js`, `dist/output.js`, `package.json` `exports`; verified empirically on 2026-07-28 |
| String passthrough, the home-header merge, and default error formatting all happen inside `runAxiCli` | `axi-sdk-js@0.1.8` `dist/cli.js` (`runHandler`, `renderCommandOutput`, `defaultFormatError`) |
| `exitCodeForError` returns 2 only for the literal code `VALIDATION_ERROR`, and `AxiCliOptions.formatError` is the supported way to widen that | `axi-sdk-js@0.1.8` `dist/errors.js`; `dist/cli.d.ts` (`formatError`) |
| awxkit CLI shape and `CONTROLLER_*` environment variables | `docs/docsite/rst/rest_api/authentication.rst`; legacy controller CLI usage docs |
| awx-mcp tool inventory and its credential gate | `lycorp-jp/awx-mcp` |
