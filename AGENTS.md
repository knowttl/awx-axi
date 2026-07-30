# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `docs/design.md` is the accepted v1 design and is authoritative. Do not edit it to fit an implementation; escalate instead.
- Every CLI surface and every review follows the AXI skill at `.agents/skills/axi/SKILL.md` (10 principles: command shape, output shape, help text, error style).
- Commands: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`. Scripts are in `package.json`.
- There is deliberately no CI workflow: GitHub Actions is disabled on this account, so the local commands above are the only gate. Do not add a workflow file without the captain's word.
- `axi-sdk-js` and `@toon-format/toon` are pinned to exact versions on purpose (design §12): the encoder's emitted syntax is observable output, so an upgrade must be a reviewed change with a snapshot diff.
- `axi-sdk-js@0.1.8` root-exports only `runAxiCli`, `AxiError`, `exitCodeForError`, `installSessionStartHooks`, `RESERVED_COMMANDS`, and the `update` helpers. The rendering helpers (`renderOutput`, `errorOutput`, `renderError`, `homeHeaderOutput`) and the `AxiRenderable` type are **not** importable: render by returning a value to the loop, report errors by throwing an `AxiError` at it.
- The captain's AWX controller is read-only by standing order: read-only GETs only, and minting a token is a POST and therefore also forbidden. Never read, print, or commit any value from `~/.config/awx-axi/live-smoke.env`.
- **All shipped v1 domains are implemented** under `src/domains/` (activity-stream, ad-hoc, approval, execution-environment, inventory, job, notification, notification-template, organization, credential, project, schedule, system-job, system-job-template, template, user, workflow, team, role) and registered in `DOMAINS` in `src/cli.ts` (19 total). The approval domain (`src/domains/approval/index.ts`) is the reference for `defineDomain` shape, a resolve-then-read plan (`approval show <id|name>` via core `resolveId`), and a derived field built from a second read (`blocks` from the workflow's node list).
- **How a domain declares its requests:** a subcommand exports a `plan` generator (`src/core/registry.ts`) that yields request descriptions - `read`, `readPaged`, `readText`, `write`, `delay` - and is resumed with each result, so a later route may depend on an earlier response (`template launch <name>`) while the domain executes nothing itself. `runPlan` is the only place a request is issued. A domain cannot express a DELETE, PUT, or PATCH: the union has no member that would carry one, asserted at compile time in `test/no-delete.test.ts`.
- **Routes are base-relative and carry no leading slash** (`jobs/1839/`, not `/api/v2/jobs/1839/`): `HttpTransport` joins `baseUrl` with `ControllerConfig.apiBasePath` once, so `AWX_AXI_API_BASE_PATH` (design §4.2) reaches every request. A leading slash would escape the API base path. AWX's own `next` link is an absolute path and is followed as given.
- A subcommand declares its positional arity as `positionals` (a `PositionalSpec` of ordered argument `names` plus how many are `required`), and a domain result is either a `Renderable` or `withExitCode(renderable, code)` - the one channel for design §7.9's "exit 1 but still print the job block".
- Tests are offline against `RecordedTransport` (domain level) or a fixture-serving `fetch` stub (`test/support/fixtures.ts`, the only way to assert `HttpTransport`'s own wire behavior). Every fixture carries `$tag`, `$source`, and `$note`; `test/fixtures.test.ts` enforces that.
- Keep this file for knowledge useful to almost every future agent session in this project.
- Do not repeat what the codebase already shows; point to the authoritative file or command instead.
- Prefer rewriting or pruning existing entries over appending new ones.
- When updating this file, preserve this bar for all agents and keep entries concise.

## External alignment and roadmap notes

- This repository should treat `https://docs.ansible.com/projects/awx/en/latest/rest_api/api_ref.html` as the current AWX reference, and `https://docs.ansible.com/projects/awx/en/24.6.1/rest_api/` plus existing `docs/design.md` and `$tag` checks as the compatibility anchor for behavior currently frozen in 24.6.1.
- Keep the read-only and non-delete contract in place by preserving `src/core/registry.ts` request kinds, `test/no-delete.test.ts`, and the captain's controller boundary.
- Current shipped coverage is all registered `DOMAINS` in `src/cli.ts`: `job`, `template`, `workflow`, `organization`, `credential`, `approval`, `ad-hoc`, `project`, `inventory`, `system-job-template`, `system-job`, `schedule`, `execution-environment`, `user`, `notification`, `notification-template`, `activity-stream`, `team`, and `role` (19 total).
- Use `https://raw.githubusercontent.com/surgex-labs/awx-mcp-server/main/AWX_MCP_QUERY_REFERENCE.md` as the awx-mcp capability source, and treat sections 13, 14, 15, 16, and 17 in that file as local Ansible/workspace capabilities rather than AWX REST API resources.
- `AwxTransport` exports `post`, `put`, `patch`, `delete` guarded by `assertWritable` and safety environment variables (`AWX_AXI_READ_ONLY`, `AWX_AXI_ALLOW_CONFIG_WRITES`, `AWX_AXI_ALLOW_DELETES`, `AWX_AXI_ALLOW_SECURITY_WRITES`). Mutating subcommands default to `--dry-run` TOON preview unless `--confirm` is passed.
- Remaining roadmap priorities are: ad hoc command launch/diagnostic depth, and teams and RBAC context.
- Keep this AGENTS file high-level, and continue to point to authoritative files or sources rather than rewriting endpoint schemas.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
